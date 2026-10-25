"""Attempt-level analysis for Agent 2.

The current LMS export carries only a single ``Дата`` per attempt — no per-question
durations — so true time-on-task analysis is not possible yet (see SPEC §6). With
what we have, we summarise score distribution per test.
"""

from __future__ import annotations

from collections import defaultdict
from statistics import median


def per_test_scores(real_attempts) -> list[dict]:
    per: dict[str, list[float]] = defaultdict(list)
    for a in real_attempts:
        per[a.test_name].append(a.score_pct)
    return [
        {"test_name": t, "attempts": len(s), "median_score": round(median(s), 1)}
        for t, s in sorted(per.items())
    ]
