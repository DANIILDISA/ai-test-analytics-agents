"""Agent 2 — Time Analysis.

Designed for per-question / per-user timing vs. the median. The current LMS export
has no per-question durations, so for now Agent 2 works "with what we have": score
distribution per test, attempt-pattern anomalies, and the abandoned rate. It states
the timing limitation explicitly in its output.

Public entry point: :func:`analyze`.
"""

from __future__ import annotations

from collections import defaultdict

from agents.time_agent.analyzer import per_test_scores
from agents.time_agent.anomaly_detector import attempt_anomalies

_NOTE = (
    "Экспорт LMS не содержит времени на каждый вопрос, поэтому полноценный анализ "
    "времени недоступен. Выполнен анализ паттернов попыток по доступным данным."
)


def _student_rollup(attempts) -> list[dict]:
    """One roster entry per distinct student, derived from the same attempt records.

    ``best_score`` is the highest ``score_pct`` across the student's *scored*
    (non-abandoned) attempts, or ``None`` when every attempt was abandoned.
    ``status`` is ``"abandoned"`` when all of the student's attempts are abandoned,
    otherwise ``"completed"``.
    """
    by_student: dict[str, list] = defaultdict(list)
    for a in attempts:
        by_student[a.student_id].append(a)

    out: list[dict] = []
    for sid, atts in sorted(by_student.items()):
        scored = [a.score_pct for a in atts if not a.is_abandoned]
        out.append({
            "student_id": sid,
            "best_score": round(max(scored), 1) if scored else None,
            "attempts": len(atts),
            "status": "completed" if scored else "abandoned",
        })
    return out


def analyze(course, *, cfg=None) -> dict:
    attempts = course.attempts
    real = [a for a in attempts if not a.is_abandoned]
    return {
        "course_id": course.course_id,
        "note": _NOTE,
        "tests": per_test_scores(real),
        "attempt_anomalies": attempt_anomalies(attempts),
        "abandoned_rate": round(100 * sum(1 for a in attempts if a.is_abandoned) / len(attempts), 1) if attempts else 0.0,
        "students": _student_rollup(attempts),
    }
