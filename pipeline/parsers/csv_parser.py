"""Parsers for the **CSV** input format (answers + reference).

Mirror the ``.xlsx`` parsers' signatures and produce the *exact same* objects:

* :func:`parse_csv_answers` ↔ ``answer_array_parser.parse_answer_array``
* :func:`parse_csv_reference` ↔ ``reference_parser.parse_reference``

Unlike the wide xlsx layout, CSV is **flat** and long:

* answers CSV — one row per *answered question*; rows are grouped back into a
  :class:`~core.models.StudentAttempt` by ``(student_id, attempt_id)`` (or
  ``(student_id, test_name)`` when ``attempt_id`` is absent).
* reference CSV — one row per reference answer.

Column headers are matched case-insensitively. Structural problems raise a
понятный :class:`ValueError` на русском языке (the loader collects it as a
warning). Схема описана в ``docs/input_formats.md``.
"""

from __future__ import annotations

import csv
import io
import re
import uuid
from pathlib import Path
from typing import Any

from core.models import QuestionAnswer, QuestionType, ReferenceAnswer, StudentAttempt
from pipeline.parsers.excel_utils import coerce_datetime, normalize_question
from pipeline.parsers.json_parser import coerce_result_code
from pipeline.parsers.reference_parser import split_variants

# CSV answer-cell variant separator: a plain ';' (the file is single-line).
_CSV_VARIANT_SPLIT = re.compile(r";\s*")

_TRUTHY = {"1", "true", "да", "yes", "y", "истина", "+"}


_DELIMS = ";," + chr(9) + "|"


def decode_bytes(raw: bytes) -> str:
    """Decode a CSV payload: BOM-aware, then utf-8, then cp1251 (never raises)."""
    if raw[:2] in (bytes([0xFF, 0xFE]), bytes([0xFE, 0xFF])):
        return raw.decode("utf-16", errors="replace")
    for enc in ("utf-8-sig", "cp1251"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("cp1251", errors="replace")


def _consistent_delimiter(text: str) -> str | None:
    """Delimiter that splits the table rows into the SAME number of fields on (almost)
    every row. Robust against banner lines above the table (which contain commas but no
    ';') and against free text with commas inside a ';' export."""
    best: tuple[float, int, str] | None = None
    sample = text.splitlines()[:60]
    for d in _DELIMS:
        counts = [len(r) for r in csv.reader(sample, delimiter=d) if r]
        wide = [c for c in counts if c > 1]
        if len(wide) < 2:
            continue
        mode = max(set(wide), key=wide.count)
        freq = wide.count(mode) / len(wide)
        if best is None or (freq, mode) > best[:2]:
            best = (freq, mode, d)
    return best[2] if best and best[0] >= 0.6 else None


def sniff_delimiter(text: str) -> str:
    """Pick the CSV delimiter (; , tab |) with csv.Sniffer, sanity-checked on the header."""
    lines = text.splitlines()
    consistent = _consistent_delimiter(text)
    if consistent:
        return consistent
    head = lines[0] if lines else ""
    sample = chr(10).join(lines[:20])
    try:
        d = csv.Sniffer().sniff(sample, delimiters=_DELIMS).delimiter
        if d in _DELIMS and head.count(d) >= 1:
            return d
    except csv.Error:
        pass
    counts = {d: head.count(d) for d in _DELIMS}
    best = max(counts, key=counts.get)
    return best if counts[best] else ","


def read_csv_text(path: Path) -> tuple[str, str]:
    """Return ``(decoded_text, delimiter)`` for a CSV file."""
    text = decode_bytes(path.read_bytes())
    return text, sniff_delimiter(text)


def _read_rows(path: Path) -> list[dict[str, str]]:
    """Read a CSV into a list of dicts with lower-cased, trimmed header keys.

    Delimiter (``;`` / ``,`` / tab) and encoding (utf-8 / utf-8-sig / cp1251) are
    detected automatically."""
    if not path.exists():
        raise ValueError(f"Файл не найден: {path}")
    try:
        text, delim = read_csv_text(path)
    except OSError as exc:  # pragma: no cover - filesystem edge
        raise ValueError(f"Не удалось прочитать файл {path}: {exc}") from exc
    reader = csv.DictReader(io.StringIO(text, newline=""), delimiter=delim)
    if not reader.fieldnames:
        raise ValueError(f"CSV-файл {path.name} пуст или не содержит заголовок")
    rows: list[dict[str, str]] = []
    for row in reader:
        rows.append(
            {
                (k or "").strip().casefold(): ("" if v is None else str(v).strip())
                for k, v in row.items()
                if k is not None
            }
        )
    return rows


def _get(row: dict[str, str], *names: str) -> str:
    for n in names:
        v = row.get(n, "")
        if v:
            return v
    return ""


def _to_int(value: str) -> int:
    text = (value or "").strip()
    if not text:
        return 0
    try:
        return int(float(text.replace(",", ".")))
    except ValueError:
        return 0


def _is_blank_row(row: dict[str, str]) -> bool:
    return not any(v.strip() for v in row.values())


_BANNER_TEST_RE = re.compile(r"(?:^|[.;:\s])(?:тест|test)\s*[:：]\s*(?P<name>[^;]+?)\s*$", re.IGNORECASE)


def _wide_csv_rows(text: str, delim: str) -> list[tuple] | None:
    """The CSV as a grid when it is a WIDE export (the xlsx layout saved as CSV: banner
    rows, a heading row and a Тип/Результат/... sub-header row), else ``None``."""
    from pipeline.parsers.answer_array_parser import _subheader_score

    grid = [tuple(r) for r in csv.reader(io.StringIO(text, newline=""), delimiter=delim)]
    if any(_subheader_score(r) >= 3 for r in grid[:25]):
        return grid
    return None


def _wide_test_name(grid: list[tuple], path: Path) -> str:
    """Test name of a wide CSV: «Тест: X» in the banner rows, else the file name."""
    for row in grid[:6]:
        for cell in row:
            m = _BANNER_TEST_RE.search(str(cell or "").strip())
            if m:
                return m.group("name").strip()
    stem = re.sub(r"[_\-]+", " ", path.stem)
    return re.sub(r"\s*\(\d+\)$", "", stem).strip() or path.stem


def parse_csv_answers(
    filepath: str | Path, course_id: str, notes: list[str] | None = None
) -> list[StudentAttempt]:
    """Parse a flat answers CSV into a list of :class:`StudentAttempt`.

    One row == one answered question. Rows sharing the same student+attempt are
    grouped into a single attempt; attempt-level columns are taken from the first
    row of each group.
    """
    path = Path(filepath)
    if path.exists():
        text, delim = read_csv_text(path)
        grid = _wide_csv_rows(text, delim)
        if grid is not None:
            from pipeline.parsers.answer_array_parser import _note, _infer_result_codes, parse_sheet_rows

            test_name = _wide_test_name(grid, path)
            raw_codes: dict[int, str] = {}
            attempts = parse_sheet_rows(
                grid, test_name, course_id=course_id, filepath=str(path),
                notes=notes, raw_codes=raw_codes,
            )
            if raw_codes:
                _infer_result_codes(attempts, raw_codes, notes)
            _note(notes, f"Файл «{path.name}»: CSV в «широком» формате (как лист Excel), "
                         f"название теста взято из шапки: «{test_name}».")
            return attempts
    rows = _read_rows(path)

    groups: dict[tuple[str, str], dict[str, Any]] = {}
    order: list[tuple[str, str]] = []

    for i, row in enumerate(rows):
        if _is_blank_row(row):
            continue
        student_id = _get(row, "student_id", "student", "пользователь")
        if not student_id:
            raise ValueError(
                f"Строка {i + 2} файла {path.name}: отсутствует обязательное поле student_id"
            )
        attempt_id = _get(row, "attempt_id")
        test_name = _get(row, "test_name", "test", "тест")
        key = (student_id, attempt_id or test_name)

        if key not in groups:
            order.append(key)
            groups[key] = {
                "attempt_id": attempt_id or str(uuid.uuid4()),
                "student_id": student_id,
                "test_name": test_name,
                "attempt_date": _get(row, "attempt_date", "дата"),
                "score_points": _to_int(_get(row, "score_points")),
                "score_max": _to_int(_get(row, "score_max")),
                "status": _get(row, "status", "статус"),
                "answers": [],
            }

        question = _get(row, "question", "question_text", "вопрос")
        if not question:
            continue  # attempt-level-only row (no question on this line)
        given = _get(row, "given_answer", "given", "полученный ответ")
        is_answered_raw = _get(row, "is_answered")
        is_answered = (
            is_answered_raw.casefold() in _TRUTHY if is_answered_raw else bool(given)
        )
        groups[key]["answers"].append(
            QuestionAnswer(
                question_text=question,
                question_type=QuestionType.from_raw(
                    _get(row, "question_type", "type", "тип")
                ),
                result_code=coerce_result_code(
                    _get(row, "result_code", "result", "результат")
                ),
                given_answer=given,
                correct_answer=_get(row, "correct_answer", "correct", "правильный ответ"),
                is_answered=is_answered,
            )
        )

    attempts: list[StudentAttempt] = []
    for key in order:
        acc = groups[key]
        answers = acc["answers"]
        points, maximum = acc["score_points"], acc["score_max"]
        pct = round(100.0 * points / maximum, 1) if maximum else 0.0
        answered_any = any(a.is_answered for a in answers)
        attempts.append(
            StudentAttempt(
                attempt_id=acc["attempt_id"],
                student_id=acc["student_id"],
                course_id=course_id,
                test_name=acc["test_name"],
                attempt_date=coerce_datetime(acc["attempt_date"]),
                score_points=points,
                score_max=maximum,
                score_pct=pct,
                status=acc["status"],
                is_abandoned=(pct == 0.0 and not answered_any),
                answers=answers,
            )
        )
    return attempts


def parse_csv_reference(filepath: str | Path) -> dict[str, dict[str, ReferenceAnswer]]:
    """Parse a flat reference CSV into ``{test_name: {norm_question: ReferenceAnswer}}``.

    One row == one reference answer. Questions are keyed by the SAME
    normalisation the xlsx reference uses (:func:`normalize_question`).
    """
    path = Path(filepath)
    rows = _read_rows(path)

    book: dict[str, dict[str, ReferenceAnswer]] = {}
    for i, row in enumerate(rows):
        if _is_blank_row(row):
            continue
        test_name = _get(row, "test_name", "test", "тест")
        if not test_name:
            raise ValueError(
                f"Строка {i + 2} файла {path.name}: отсутствует обязательное поле test_name"
            )
        question = _get(row, "question", "question_text", "вопрос")
        if not question:
            raise ValueError(
                f"Строка {i + 2} файла {path.name}: отсутствует текст вопроса (question)"
            )
        raw_answer = _get(row, "correct_answer", "raw_answer", "правильный ответ")
        acceptable_field = _get(row, "acceptable", "варианты")
        if acceptable_field:
            acceptable = [p.strip() for p in _CSV_VARIANT_SPLIT.split(acceptable_field) if p.strip()]
        else:
            acceptable = split_variants(raw_answer)

        book.setdefault(test_name, {})[normalize_question(question)] = ReferenceAnswer(
            test_name=test_name,
            question_text=question,
            raw_answer=raw_answer,
            acceptable=acceptable,
        )
    return book
