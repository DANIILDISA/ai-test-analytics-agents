"""Attempt-pattern anomaly flags for Agent 2.

Without timings we flag the next-best signals available in the data:

* a student making many attempts whose score then jumps sharply — a possible sign of
  answer memorisation across retries rather than genuine improvement; and
* a sharp jump FROM a brushed-off (abandoned) or near-zero attempt TO a high score —
  the classic "got outside help / memorised the answers between tries" signal. This one
  must keep the abandoned/low attempt in the sequence: filtering it out first would hide
  exactly the pattern we are looking for (``[0% abandoned, 80%]`` looks like a single
  high attempt once the 0% is dropped).
"""

from __future__ import annotations

from collections import defaultdict


def _chronological(atts: list) -> list:
    """Order a student's attempts in time so a low->high jump is a real progression.

    Attempts carrying a date are sorted by it; undated attempts keep their original
    relative order at the end (avoids comparing ``None`` / mixed tz-awareness)."""
    dated = sorted(
        (a for a in atts if a.attempt_date is not None),
        key=lambda a: a.attempt_date,
    )
    undated = [a for a in atts if a.attempt_date is None]
    return dated + undated


def _abandoned_jump(ordered: list, *, min_jump: float, low_score: float):
    """Largest jump from an abandoned/very-low anchor to a later, higher real score."""
    best = None  # (anchor_score, target_score)
    for i, anchor in enumerate(ordered):
        if not (anchor.is_abandoned or anchor.score_pct <= low_score):
            continue
        for target in ordered[i + 1:]:
            if target.is_abandoned:
                continue
            jump = target.score_pct - anchor.score_pct
            if jump >= min_jump and (best is None or jump > (best[1] - best[0])):
                best = (anchor.score_pct, target.score_pct)
    return best


def attempt_anomalies(
    attempts,
    *,
    min_attempts: int = 3,
    min_jump: float = 50.0,
    low_score: float = 20.0,
) -> list[dict]:
    by_student: dict[str, list] = defaultdict(list)
    for a in attempts:
        by_student[a.student_id].append(a)

    out: list[dict] = []
    for sid, atts in by_student.items():
        ordered = _chronological(atts)

        # Signal 1: abandoned/near-zero attempt followed by a high score. No min_attempts
        # guard — two attempts ([abandoned, 85%]) are already the whole signal.
        jump = _abandoned_jump(ordered, min_jump=min_jump, low_score=low_score)
        if jump is not None:
            out.append({
                "student_id": sid,
                "attempts": len(ordered),
                "score_min": round(jump[0], 1),
                "score_max": round(jump[1], 1),
                "reason": "резкий скачок балла после брошенной/проваленной попытки "
                          "(возможна посторонняя помощь или запоминание ответов)",
            })
            continue  # one flag per student — do not also count it under signal 2

        # Signal 2 (original): many genuine attempts with a large overall score spread.
        real = [a for a in ordered if not a.is_abandoned]
        if len(real) < min_attempts:
            continue
        scores = [a.score_pct for a in real]
        if max(scores) - min(scores) >= min_jump:
            out.append({
                "student_id": sid,
                "attempts": len(real),
                "score_min": round(min(scores), 1),
                "score_max": round(max(scores), 1),
                "reason": "много попыток и большой рост балла (возможно запоминание ответов)",
            })
    return out
