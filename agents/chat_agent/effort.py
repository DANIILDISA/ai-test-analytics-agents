# agents/chat_agent/effort.py
"""Effort level -> max agent steps (tool-call/reason iterations) per question.

Portable across providers (spec D5): this caps loop iterations regardless of model.
Numbers are tunable; the UI exposes Низкий/Средний/Высокий, mapped to these keys.
"""

from __future__ import annotations

EFFORT_BUDGETS: dict[str, int] = {"low": 2, "medium": 4, "high": 8}
_DEFAULT = "high"


def step_budget(effort: str | None) -> int:
    """Max loop steps for an effort level; defaults to medium for unknown input."""
    key = str(effort).strip().lower() if effort is not None else _DEFAULT
    return EFFORT_BUDGETS.get(key, EFFORT_BUDGETS[_DEFAULT])
