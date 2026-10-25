"""Pattern detection for Agent 1: critical questions + common errors.

Zero-token. A question is "critical" when enough students answered it and the
correct rate falls below the configured threshold — i.e. a likely problem with the
question or the teaching, not just one weak student.
"""

from __future__ import annotations

from pipeline.stats import QuestionStat


def is_critical(qs: QuestionStat, *, critical_rate: float, min_samples: int = 10) -> bool:
    return qs.answered >= min_samples and qs.correct_rate < critical_rate


def common_errors(qs: QuestionStat, top: int = 3) -> list[dict]:
    return [
        {"answer": ans, "count": cnt}
        for ans, cnt in qs.wrong_answers.most_common(top)
        if ans
    ]
