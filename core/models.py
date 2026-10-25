"""Pydantic v2 data models for parsed e-learning test results.

These models are produced by the parsers (Layer 1) and consumed by the
statistics engine (Layer 2) and beyond. They intentionally stay close to the
raw LMS export: the LMS has *already* graded every answer (``result_code``), so
nothing here re-grades — it only normalises the wide Excel export into records.
"""

from __future__ import annotations

import re
from datetime import datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, computed_field


class QuestionType(str, Enum):
    """Question types seen across the real exports.

    ``RANKING`` ("ранжирование") and ``UNKNOWN`` are extensions beyond the
    original spec: ``RANKING`` appears in real data (course 021) and ``UNKNOWN``
    is a safety net so an unexpected type label can never crash a parse.
    """

    SINGLE_CHOICE = "единственный выбор"
    MULTI_CHOICE = "множественный выбор"
    TEXT_INPUT = "текстовый ввод"
    NUMERIC_INPUT = "числовой ввод"
    MATCHING = "соответствие"
    RANKING = "ранжирование"
    UNKNOWN = "неизвестно"

    @classmethod
    def from_raw(cls, raw: str | None) -> "QuestionType":
        """Map a raw ``Тип`` cell to a member, tolerating case/whitespace."""
        if not raw:
            return cls.UNKNOWN
        key = re.sub(r"\s+", " ", str(raw).strip().lower())
        for member in cls:
            if member.value == key:
                return member
        return cls.UNKNOWN

    @property
    def needs_semantic_check(self) -> bool:
        """True only for free-form types whose wrong answers warrant LLM review.

        Choice / ranking / matching are graded by the LMS code alone — never
        sent to an LLM (token-optimization Rule 5).
        """
        return self in (QuestionType.TEXT_INPUT, QuestionType.NUMERIC_INPUT)


#: Share of a point given for a «Частично» answer.
PARTIAL_CREDIT = 0.5


class ResultCode(str, Enum):
    """The LMS verdict embedded in each answer's ``Результат`` cell."""

    CORRECT = "lcnwu5wcgk"
    WRONG = "r1s987zw3e"
    #: Partial credit (multiple choice answered with a proper subset, ...). Counts as
    #: neither correct nor wrong; worth :data:`PARTIAL_CREDIT` of a point.
    PARTIAL = "partial"

    @classmethod
    def from_raw(cls, raw: str | None) -> "ResultCode | None":
        """Map a raw ``Результат`` cell to a member, or ``None`` if absent/unknown.

        Besides the two LMS hashes, textual verdicts are accepted (верно / неверно /
        правильно / да / нет / 1 / 0 / true / false ...), see :data:`RESULT_SYNONYMS`.
        """
        if raw is None:
            return None
        key = str(raw).strip()
        if not key:
            return None
        for member in cls:
            if member.value == key:
                return member
        return RESULT_SYNONYMS.get(re.sub(r"\s+", " ", key.casefold()))


#: Textual / numeric verdict tokens accepted in place of the LMS hashes.
RESULT_SYNONYMS: dict[str, ResultCode] = {
    **{k: ResultCode.CORRECT for k in (
        "верно", "верный", "правильно", "правильный", "правильный ответ", "верный ответ",
        "да", "yes", "y", "истина", "correct", "right", "ok", "true", "1", "1.0", "+", "✓", "✔",
    )},
    **{k: ResultCode.PARTIAL for k in (
        "частично", "частично верно", "частично правильно", "неполный", "неполностью",
        "partial", "partially correct", "partially",
    )},
    **{k: ResultCode.WRONG for k in (
        "неверно", "неверный", "неправильно", "неправильный", "неправильный ответ",
        "неверный ответ", "ошибка", "нет", "no", "n", "ложь", "wrong", "incorrect",
        "false", "0", "0.0", "-", "✗", "✘",
    )},
}


_PASSED_WORDS = {
    "пройден", "пройдено", "зачтено", "зачет", "зачёт", "сдан", "сдано", "успешно",
    "выполнено", "аттестован", "passed", "pass", "success", "ok",
}


def is_passed_status(status: str) -> bool:
    """True for a «passed» status word (Пройден / Зачтено / Зачёт / Сдан ...); the
    negations (Не пройден / Не зачтено / Незачёт ...) are never passed."""
    s = " ".join((status or "").split()).casefold().replace("ё", "е")
    if not s or s.startswith("не ") or s.startswith("не-") or s.startswith("незач"):
        return False
    return s.replace("ё", "е") in {w.replace("ё", "е") for w in _PASSED_WORDS}


class QuestionAnswer(BaseModel):
    """One student's answer to one question within an attempt."""

    model_config = ConfigDict(use_enum_values=False)

    question_text: str
    question_type: QuestionType
    result_code: ResultCode | None = None
    given_answer: str = ""
    correct_answer: str = ""
    is_answered: bool = False

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_correct(self) -> bool:
        return self.result_code is ResultCode.CORRECT

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_wrong(self) -> bool:
        return self.result_code is ResultCode.WRONG

    @property
    def is_partial(self) -> bool:
        return self.result_code is ResultCode.PARTIAL

    @property
    def credit(self) -> float:
        """Points earned for this answer: 1 (верно), 0.5 (частично), 0 otherwise."""
        if self.result_code is ResultCode.CORRECT:
            return 1.0
        if self.result_code is ResultCode.PARTIAL:
            return PARTIAL_CREDIT
        return 0.0


class StudentAttempt(BaseModel):
    """A single test attempt by one student (one data row in a Массив sheet)."""

    model_config = ConfigDict(use_enum_values=False)

    attempt_id: str
    student_id: str
    course_id: str
    test_name: str
    attempt_date: datetime | None = None
    score_points: float = 0
    score_max: float = 0
    score_pct: float = 0.0
    status: str = ""
    is_abandoned: bool = False
    answers: list[QuestionAnswer] = Field(default_factory=list)

    @property
    def is_passed(self) -> bool:
        return is_passed_status(self.status)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def answered_count(self) -> int:
        return sum(1 for a in self.answers if a.is_answered)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def correct_count(self) -> int:
        return sum(1 for a in self.answers if a.is_correct)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def wrong_count(self) -> int:
        return sum(1 for a in self.answers if a.is_wrong)


class ReferenceAnswer(BaseModel):
    """A canonical answer key entry parsed from an Эталон file.

    ``acceptable`` holds the split variants; ``raw_answer`` keeps the original
    cell so the comparison layer can decide how aggressively to split.
    """

    test_name: str
    question_text: str
    raw_answer: str
    acceptable: list[str] = Field(default_factory=list)
