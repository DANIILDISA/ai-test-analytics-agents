"""Layer-2 statistics engine (zero LLM tokens).

Aggregates parsed attempts into per-question and per-course metrics that feed the
agents. This module is the home for the "statistics engine" (the README has no
dedicated dir; see SPEC §6). Only real (non-abandoned) attempts are counted.
"""

from __future__ import annotations

import hashlib
from collections import Counter
from dataclasses import dataclass, field
from statistics import mean

from core.models import PARTIAL_CREDIT, QuestionType, StudentAttempt
from pipeline.parsers.excel_utils import normalize_question


@dataclass
class QuestionStat:
    question_id: str
    test_name: str
    question_text: str
    qtype: QuestionType
    answered: int = 0
    correct: int = 0
    wrong: int = 0
    partial: int = 0
    correct_sample: str = ""
    wrong_answers: Counter = field(default_factory=Counter)

    @property
    def correct_rate(self) -> float:
        """Share of earned credit: верно = 1, частично = 0.5, неверно = 0."""
        earned = self.correct + PARTIAL_CREDIT * self.partial
        return round(earned / self.answered, 4) if self.answered else 0.0


def real_attempts(attempts: list[StudentAttempt]) -> list[StudentAttempt]:
    return [a for a in attempts if not a.is_abandoned]


def _qid(test: str, normq: str) -> str:
    return hashlib.md5(f"{test}|{normq}".encode("utf-8")).hexdigest()[:8]


def question_stats(attempts: list[StudentAttempt]) -> list[QuestionStat]:
    """One :class:`QuestionStat` per distinct (test, normalised question)."""
    by_key: dict[tuple[str, str], QuestionStat] = {}
    for a in real_attempts(attempts):
        for ans in a.answers:
            if not ans.is_answered:
                continue
            normq = normalize_question(ans.question_text)
            key = (a.test_name, normq)
            qs = by_key.get(key)
            if qs is None:
                qs = QuestionStat(
                    question_id=_qid(a.test_name, normq),
                    test_name=a.test_name,
                    question_text=ans.question_text,
                    qtype=ans.question_type,
                )
                by_key[key] = qs
            qs.answered += 1
            if ans.correct_answer and not qs.correct_sample:
                qs.correct_sample = ans.correct_answer
            if ans.is_correct:
                qs.correct += 1
            elif ans.is_partial:
                qs.partial += 1
            elif ans.is_wrong:
                qs.wrong += 1
                if ans.given_answer:
                    qs.wrong_answers[ans.given_answer] += 1
    return list(by_key.values())


def course_summary(attempts: list[StudentAttempt], *, total_questions: int | None = None) -> dict:
    real = real_attempts(attempts)
    students = {a.student_id for a in real}
    scores = [a.score_pct for a in real]
    return {
        "total_users": len(students),
        "total_questions": total_questions if total_questions is not None else len(question_stats(attempts)),
        "avg_score": round(mean(scores), 1) if scores else 0.0,
        "real_attempts": len(real),
        "abandoned": sum(1 for a in attempts if a.is_abandoned),
    }
