"""Parsers for the **JSON** input format (answers + reference).

These mirror the ``.xlsx`` parsers' signatures and produce the *exact same*
objects, so the rest of the engine is untouched:

* :func:`parse_json_answers` ↔ ``answer_array_parser.parse_answer_array``
* :func:`parse_json_reference` ↔ ``reference_parser.parse_reference``

The JSON answer schema deliberately mirrors the Pydantic
:class:`~core.models.StudentAttempt` / :class:`~core.models.QuestionAnswer`
models so an attempt is built straight from the file via ``model_validate`` —
the schema *is* the model. A small, defensive normalisation pass beforehand
keeps the file human-writable (friendly ``question_type`` labels and ``result``
tokens, optional ``attempt_id`` / ``score_pct`` / ``is_answered``).

Любая структурная ошибка (битый JSON, отсутствующее обязательное поле) поднимает
понятный :class:`ValueError` на русском языке — загрузчик собирает его как
предупреждение, а не прерывает разбор всего пакета файлов.

Схема подробно описана в ``docs/input_formats.md``.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from core.models import (
    QuestionType,
    ReferenceAnswer,
    ResultCode,
    StudentAttempt,
)
from pipeline.parsers.excel_utils import coerce_datetime, normalize_question
from pipeline.parsers.reference_parser import split_variants

# Friendly synonyms for the LMS verdict, so a human/judge does not have to write
# the cryptic LMS codes ("lcnwu5wcgk"/"r1s987zw3e"). The raw codes are still
# accepted verbatim (via ``ResultCode.from_raw``) for round-tripping real data.
_RESULT_SYNONYMS: dict[str, ResultCode] = {
    "верно": ResultCode.CORRECT,
    "правильно": ResultCode.CORRECT,
    "correct": ResultCode.CORRECT,
    "right": ResultCode.CORRECT,
    "ok": ResultCode.CORRECT,
    "true": ResultCode.CORRECT,
    "1": ResultCode.CORRECT,
    "+": ResultCode.CORRECT,
    "неверно": ResultCode.WRONG,
    "неправильно": ResultCode.WRONG,
    "ошибка": ResultCode.WRONG,
    "wrong": ResultCode.WRONG,
    "incorrect": ResultCode.WRONG,
    "false": ResultCode.WRONG,
    "0": ResultCode.WRONG,
    "-": ResultCode.WRONG,
}


def coerce_result_code(value: object) -> ResultCode | None:
    """Map a raw/friendly ``result`` cell to a :class:`ResultCode` (or ``None``).

    Accepts the raw LMS code, a friendly RU/EN token, or nothing.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    code = ResultCode.from_raw(text)  # exact LMS-code match first
    if code is not None:
        return code
    return _RESULT_SYNONYMS.get(text.casefold())


def _str(value: object) -> str:
    """Trim to a ``str`` (``None`` -> "")."""
    return "" if value is None else str(value).strip()


def _normalize_answer(raw: object) -> dict[str, Any]:
    """Coerce one answer object into a ``QuestionAnswer``-shaped dict."""
    if not isinstance(raw, dict):
        raise ValueError("каждый ответ должен быть объектом JSON")
    question_text = _str(raw.get("question_text") or raw.get("question"))
    if not question_text:
        raise ValueError("у ответа отсутствует текст вопроса (question_text)")
    given = _str(raw.get("given_answer") if raw.get("given_answer") is not None else raw.get("given"))
    correct = _str(
        raw.get("correct_answer") if raw.get("correct_answer") is not None else raw.get("correct")
    )
    is_answered = raw.get("is_answered")
    if is_answered is None:
        is_answered = bool(given)
    return {
        "question_text": question_text,
        # from_raw never crashes: unknown/missing label -> QuestionType.UNKNOWN.
        "question_type": QuestionType.from_raw(raw.get("question_type") or raw.get("type")),
        "result_code": coerce_result_code(
            raw.get("result_code") if raw.get("result_code") is not None else raw.get("result")
        ),
        "given_answer": given,
        "correct_answer": correct,
        "is_answered": bool(is_answered),
    }


def _normalize_attempt(raw: object, course_id: str) -> dict[str, Any]:
    """Coerce one attempt object into a ``StudentAttempt``-shaped dict."""
    if not isinstance(raw, dict):
        raise ValueError("каждая попытка должна быть объектом JSON")

    student_id = _str(raw.get("student_id"))
    if not student_id:
        raise ValueError("в попытке отсутствует обязательное поле student_id")
    test_name = _str(raw.get("test_name"))
    if not test_name:
        raise ValueError("в попытке отсутствует обязательное поле test_name")

    raw_answers = raw.get("answers") or []
    if not isinstance(raw_answers, list):
        raise ValueError("поле answers должно быть списком ответов")
    answers = [_normalize_answer(a) for a in raw_answers]
    answered_any = any(a["is_answered"] for a in answers)

    points = _coerce_int(raw.get("score_points"))
    maximum = _coerce_int(raw.get("score_max"))
    pct = raw.get("score_pct")
    if pct is None:
        pct = round(100.0 * points / maximum, 1) if maximum else 0.0

    is_abandoned = raw.get("is_abandoned")
    if is_abandoned is None:
        is_abandoned = float(pct) == 0.0 and not answered_any

    return {
        "attempt_id": _str(raw.get("attempt_id")) or str(uuid.uuid4()),
        "student_id": student_id,
        "course_id": course_id,  # always the caller's id, like the xlsx parser
        "test_name": test_name,
        # Coerce here (not in pydantic) so JSON and CSV share one date path.
        "attempt_date": coerce_datetime(raw.get("attempt_date")),
        "score_points": points,
        "score_max": maximum,
        "score_pct": float(pct),
        "status": _str(raw.get("status")),
        "is_abandoned": bool(is_abandoned),
        "answers": answers,
    }


def _coerce_int(value: object) -> int:
    if value is None or value == "":
        return 0
    try:
        return int(float(str(value).replace(",", ".")))
    except (TypeError, ValueError):
        return 0


def _load_json_list(path: Path, what: str) -> list:
    if not path.exists():
        raise ValueError(f"Файл не найден: {path}")
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError as exc:  # pragma: no cover - filesystem edge
        raise ValueError(f"Не удалось прочитать файл {path}: {exc}") from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Некорректный JSON в файле {path.name}: {exc}") from exc
    if not isinstance(data, list):
        raise ValueError(
            f"{what} в JSON должен быть списком, получено: {type(data).__name__}"
        )
    return data


def parse_json_answers(filepath: str | Path, course_id: str) -> list[StudentAttempt]:
    """Parse a JSON answers file into a flat list of :class:`StudentAttempt`.

    The file is a JSON **list** of attempt objects whose fields mirror
    ``StudentAttempt`` (with nested ``answers`` mirroring ``QuestionAnswer``).
    """
    path = Path(filepath)
    data = _load_json_list(path, "Файл ответов")

    attempts: list[StudentAttempt] = []
    for i, obj in enumerate(data):
        try:
            normalized = _normalize_attempt(obj, course_id)
            attempts.append(StudentAttempt.model_validate(normalized))
        except (ValueError, ValidationError) as exc:
            raise ValueError(
                f"Ошибка в попытке №{i + 1} файла {path.name}: {exc}"
            ) from exc
    return attempts


def _build_reference(raw: object) -> ReferenceAnswer:
    """Coerce one reference entry into a :class:`ReferenceAnswer`."""
    if not isinstance(raw, dict):
        raise ValueError("каждая запись эталона должна быть объектом JSON")
    test_name = _str(raw.get("test_name"))
    if not test_name:
        raise ValueError("в записи эталона отсутствует обязательное поле test_name")
    question_text = _str(raw.get("question_text") or raw.get("question"))
    if not question_text:
        raise ValueError("в записи эталона отсутствует текст вопроса (question)")

    raw_answer = raw.get("raw_answer")
    if raw_answer is None:
        raw_answer = raw.get("correct_answer")
    raw_answer = _str(raw_answer)

    acceptable_field = raw.get("acceptable")
    if isinstance(acceptable_field, list):
        acceptable = [s for s in (_str(x) for x in acceptable_field) if s]
    elif acceptable_field:
        acceptable = split_variants(str(acceptable_field))
    else:
        # Mirror the xlsx reference: derive variants from the answer cell.
        acceptable = split_variants(raw_answer)

    return ReferenceAnswer(
        test_name=test_name,
        question_text=question_text,
        raw_answer=raw_answer,
        acceptable=acceptable,
    )


def parse_json_reference(filepath: str | Path) -> dict[str, dict[str, ReferenceAnswer]]:
    """Parse a JSON reference file into ``{test_name: {norm_question: ReferenceAnswer}}``.

    The file is a JSON **list** of reference entries (``test_name`` + ``question``
    + the answer fields). Questions are keyed by the SAME normalisation the xlsx
    reference uses (:func:`normalize_question`).
    """
    path = Path(filepath)
    data = _load_json_list(path, "Файл эталона")

    book: dict[str, dict[str, ReferenceAnswer]] = {}
    for i, entry in enumerate(data):
        try:
            ref = _build_reference(entry)
        except ValueError as exc:
            raise ValueError(
                f"Ошибка в записи эталона №{i + 1} файла {path.name}: {exc}"
            ) from exc
        book.setdefault(ref.test_name, {})[normalize_question(ref.question_text)] = ref
    return book
