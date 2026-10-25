"""Pipeline orchestrator: run the selected agents over one course.

Wires already-independent agents together; holds no agent-specific logic. Agent 3
(report) is invoked by the caller (``main``) after this returns the assembled result.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class RunOptions:
    modes: set[str] = field(default_factory=lambda: {"answer", "time"})  # subset of {"answer","time"}
    max_llm_calls: int = 0


def usage_total_tokens(usage: dict) -> int:
    """Sum every token kind the LLM usage block reports (prompt + completion + reasoning)."""
    return (
        int(usage.get("prompt_tokens", 0))
        + int(usage.get("completion_tokens", 0))
        + int(usage.get("reasoning_tokens", 0))
    )


def budget_exceeded(usage: dict, budget: int | None) -> bool:
    """True when total tokens exceed a positive budget. A 0/None budget means
    'no limit configured' and is never flagged (the guardrail stays advisory-off)."""
    if not budget or budget <= 0:
        return False
    return usage_total_tokens(usage) > budget


def run_course(course, cfg, client, options: RunOptions, cache=None) -> dict:
    from agents import answer_agent, time_agent

    result: dict = {"course_id": course.course_id}
    if "answer" in options.modes:
        result["answer"] = answer_agent.analyze(
            course,
            client,
            critical_rate=cfg.thresholds.critical_correct_rate,
            min_samples=cfg.thresholds.min_samples,
            max_llm_calls=options.max_llm_calls,
            fuzzy_threshold=cfg.thresholds.fuzzy_accept,
            llm_batch_size=cfg.llm_batch_size,
            cache=cache,
        )
    if "time" in options.modes:
        result["time"] = time_agent.analyze(course, cfg=cfg)
    return result


def run_all(courses, cfg, client, options: RunOptions, *, cache=None, run_one=run_course):
    """Run every course independently. One course failing (e.g. an LLM rate-limit
    or network blip mid-analysis) is isolated — it does not abort the remaining
    courses (partial results over hard failure). The answer ``cache`` is saved
    after **each** course so judged answers survive a later crash.

    Returns a list of ``(course, result_or_None, error_or_None)`` tuples.
    """
    out: list[tuple] = []
    for course in courses:
        try:
            out.append((course, run_one(course, cfg, client, options, cache=cache), None))
        except Exception as exc:  # noqa: BLE001 — isolate any per-course failure
            out.append((course, None, exc))
        if cache is not None:
            cache.save()
    return out
