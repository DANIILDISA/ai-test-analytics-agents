"""Input front door: discover + load answer arrays (Массив) and reference keys (Эталон).

Accepts a single input file or a folder (scanned recursively). Three input formats
are supported, all producing the SAME ``StudentAttempt`` / ``ReferenceAnswer`` objects
so the rest of the engine is format-agnostic:

* ``.xlsx`` — the wide-format LMS exports (:mod:`pipeline.parsers.answer_array_parser`
  / :mod:`pipeline.parsers.reference_parser`);
* ``.json`` — :mod:`pipeline.parsers.json_parser`;
* ``.csv``  — :mod:`pipeline.parsers.csv_parser`.

Files are classified by name (``массив`` → answer array, ``эталон`` → reference); when the
name says neither, the file CONTENT decides (see :mod:`pipeline.file_roles`). The
``course_id`` is the parent folder name (matching the ``data/{samples,etalon}/<course>/``
layout); a file that is not inside a course folder gets it from the digits in its name.
Every parse is wrapped so one bad file becomes a warning, not an aborted run; non-fatal
findings (skipped sheets, unknown result codes, role guesses) go to ``CourseData.notes``.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

from core.exceptions import ParseError
from core.models import ReferenceAnswer, StudentAttempt
from pipeline import file_roles
from pipeline.parsers.answer_array_parser import parse_answer_array
from pipeline.parsers.reference_parser import parse_reference

_MASSIV = "массив"
_ETALON = "эталон"

# Every input extension we know how to load. A single file outside this set, or
# non-matching files inside a folder, are silently ignored (e.g. a stray README).
_SUPPORTED_SUFFIXES = (".xlsx", ".json", ".csv")


@dataclass
class CourseData:
    course_id: str
    attempts: list[StudentAttempt] = field(default_factory=list)
    reference: dict[str, dict[str, ReferenceAnswer]] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    #: Non-fatal findings from parsing: shown as warnings, they do NOT block the run.
    notes: list[str] = field(default_factory=list)
    #: Input files that could not be read at all: ``{"file": name, "reason": text}``.
    skipped: list[dict] = field(default_factory=list)

    def needs_reference(self) -> bool:
        """True when the answers contain free-form questions (text / number) that only a
        reference key lets us re-check by meaning."""
        return any(
            ans.question_type.needs_semantic_check
            for a in self.attempts
            for ans in a.answers
        )

    def validate(self, require_reference: bool = True) -> list[str]:
        """Pre-run sanity gate: return human-readable Russian problem strings.

        An empty list means the course is good enough to analyse. This NEVER raises —
        callers (web/service, main.py) decide what to do with the problems. The checks
        are intentionally LENIENT so the three valid sample courses (001/021/069) pass
        with an empty list; they only fire on genuinely unusable input.
        """
        problems: list[str] = []

        if not self.attempts:
            problems.append(
                "Не удалось прочитать ни одной попытки — проверьте формат файла ответов"
            )
        else:
            total_questions = sum(len(a.answers) for a in self.attempts)
            if total_questions == 0:
                problems.append(
                    "В загруженных попытках нет ни одного вопроса — "
                    "проверьте структуру файла ответов"
                )
            # A reference (Эталон) is only *expected* when there are free-form answers
            # (text/number) that the LMS code cannot grade on its own. Choice/matching/
            # ranking are graded deterministically and need no key — so courses 021/069
            # never trip this even without a reference.
            if require_reference and self.needs_reference() and not self.reference:
                problems.append(
                    "Эталон пуст или не загружен — свободные ответы не с чем сравнивать"
                )

        # Surface parse warnings/errors collected while loading so a partially broken
        # file pack is reported rather than silently swallowed.
        # A broken/unreadable file must not block the files that DID load: its warning
        # is then shown next to the results (course.warnings), not as a stop sign.
        if not self.attempts:
            for w in self.warnings:
                problems.append(f"Проблема при чтении файла: {w}")

        return problems


def _input_files(path: Path) -> list[Path]:
    """Collect every loadable input under ``path`` (a single file or a folder).

    Recurses into folders; skips Office lock/temp files (``~$...``). The same suffix
    whitelist applies to a single-file path so an unsupported file yields nothing.
    """
    if path.is_file():
        if path.suffix.lower() in _SUPPORTED_SUFFIXES and not path.name.startswith("~$"):
            return [path]
        return []
    return sorted(
        p
        for p in path.rglob("*")
        if p.is_file()
        and p.suffix.lower() in _SUPPORTED_SUFFIXES
        and not p.name.startswith("~$")
    )


@contextmanager
def _as_parse_error(f: Path) -> Iterator[None]:
    """Normalise a parser's ``ValueError`` into a ``ParseError`` carrying the path.

    The JSON/CSV parsers raise ``ValueError`` (with a friendly Russian message) on
    malformed input; the ``.xlsx`` parsers raise ``ParseError``. Re-wrapping here lets
    :func:`load` keep a single ``except ParseError`` warning path for every format.
    """
    try:
        yield
    except ValueError as exc:
        raise ParseError(str(exc), filepath=str(f)) from exc


def _friendly(exc: ParseError, filename: str) -> str:
    """The parser's message without the technical «[temp path | sheet]» suffix, always
    naming the file."""
    msg = getattr(exc, "reason", None) or str(exc)
    return msg if filename in msg else f"Файл «{filename}»: {msg}"


def _classify(name: str, f: Path | None = None) -> str:
    """Role of an input file: by name first, by content when the name is silent."""
    by_name = file_roles.classify_by_name(name)
    if by_name is not None:
        return by_name
    if f is not None and f.exists():
        return file_roles.sniff_role(f)
    return file_roles.MASSIV  # default: treat unknown answer-pack files as arrays


def _parse_answers(f: Path, course_id: str, notes: list[str] | None = None) -> list[StudentAttempt]:
    """Dispatch an answer-array file to the parser matching its extension.

    The ``.json`` / ``.csv`` parsers are imported lazily so this module loads even
    when only the ``.xlsx`` path is exercised; both mirror ``parse_answer_array``'s
    signature (return ``list[StudentAttempt]``). They raise ``ValueError`` on
    malformed input, which we normalise to ``ParseError`` so the loader's single
    ``except ParseError`` warning path covers every format.
    """
    ext = f.suffix.lower()
    if ext == ".json":
        from pipeline.parsers.json_parser import parse_json_answers

        with _as_parse_error(f):
            return parse_json_answers(f, course_id)
    if ext == ".csv":
        from pipeline.parsers.csv_parser import parse_csv_answers

        with _as_parse_error(f):
            return parse_csv_answers(f, course_id, notes)
    return parse_answer_array(f, course_id, notes)  # .xlsx (default)


def _parse_ref(f: Path, notes: list[str] | None = None) -> dict[str, dict[str, ReferenceAnswer]]:
    """Dispatch a reference (Эталон) file to the parser matching its extension."""
    ext = f.suffix.lower()
    if ext == ".json":
        from pipeline.parsers.json_parser import parse_json_reference

        with _as_parse_error(f):
            return parse_json_reference(f)
    if ext == ".csv":
        from pipeline.parsers.csv_parser import parse_csv_reference

        with _as_parse_error(f):
            return parse_csv_reference(f)
    return parse_reference(f, notes)  # .xlsx (default)


def _merge_ref(dst: dict[str, dict[str, ReferenceAnswer]], book: dict[str, dict[str, ReferenceAnswer]]) -> None:
    for test, qmap in book.items():
        dst.setdefault(test, {}).update(qmap)


def load(input_path: str | Path, reference_path: str | Path | None = None) -> list[CourseData]:
    """Load all courses found under ``input_path`` (+ optional ``reference_path``)."""
    courses: dict[str, CourseData] = {}

    in_path = Path(input_path)
    if not in_path.exists():
        raise ParseError("input path does not exist", filepath=str(in_path))

    for f in _input_files(in_path):
        cid = file_roles.course_id_for(f, in_path)
        cd = courses.setdefault(cid, CourseData(course_id=cid))
        kind = _classify(f.name, f)
        if file_roles.fix_mojibake(f.name) != f.name:
            cd.notes.append(
                f"Имя файла «{f.name}» испорчено кодировкой; прочитано как "
                f"«{file_roles.fix_mojibake(f.name)}»."
            )
        if file_roles.classify_by_name(f.name) is None:
            role = "эталон ответов" if kind == "etalon" else "массив ответов"
            cd.notes.append(f"Файл «{f.name}»: роль определена по содержимому - {role}.")
        try:
            if kind == "etalon":
                _merge_ref(cd.reference, _parse_ref(f, cd.notes))
            else:
                cd.attempts.extend(_parse_answers(f, cid, cd.notes))
        except ParseError as exc:
            msg = _friendly(exc, f.name)
            cd.warnings.append(msg)
            cd.skipped.append({"file": f.name, "reason": msg})

    if reference_path is not None:
        ref_path = Path(reference_path)
        if ref_path.exists():
            for f in _input_files(ref_path):
                if _classify(f.name, f) == "massiv":
                    continue
                cid = file_roles.course_id_for(f, ref_path)
                cd = courses.setdefault(cid, CourseData(course_id=cid))
                try:
                    _merge_ref(cd.reference, _parse_ref(f, cd.notes))
                except ParseError as exc:
                    msg = _friendly(exc, f.name)
                    cd.warnings.append(msg)
                    cd.skipped.append({"file": f.name, "reason": msg})

    _attach_orphan_references(courses)
    for cd in courses.values():
        _align_reference_sheets(cd)
    return [courses[c] for c in sorted(courses)]


def _sheet_key(name: str) -> str:
    return " ".join(str(name).split()).casefold().replace("ё", "е")


def _align_reference_sheets(cd: CourseData) -> None:
    """Эталон sheet «итоговый тест» vs Массив sheet «Итоговый тест»: rename the reference
    sheet to the attempts' spelling when they differ only by case / spacing / ё."""
    tests = {_sheet_key(a.test_name): a.test_name for a in cd.attempts}
    renamed: dict[str, dict] = {}
    for name, book in list(cd.reference.items()):
        target = tests.get(_sheet_key(name))
        if target and target != name and target not in cd.reference:
            renamed[target] = book
            del cd.reference[name]
            cd.notes.append(f"Лист эталона «{name}» сопоставлен с тестом «{target}».")
    cd.reference.update(renamed)


def _attach_orphan_references(courses: dict[str, CourseData]) -> None:
    """A folder holding only a reference (no attempts) while exactly one other course has
    attempts but no reference: the key obviously belongs to it (folder names differ).
    Merge them and say so."""
    orphans = [c for c in courses.values() if c.reference and not c.attempts]
    needy = [c for c in courses.values() if c.attempts and not c.reference]
    if len(orphans) == 1 and len(needy) == 1:
        o, n = orphans[0], needy[0]
        n.reference = o.reference
        n.notes.extend(o.notes)
        n.notes.append(
            f"Эталон из «{o.course_id}» привязан к курсу «{n.course_id}»: "
            f"папки называются по-разному, других вариантов нет."
        )
        del courses[o.course_id]
