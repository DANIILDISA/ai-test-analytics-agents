"""Agent 4 — AI Insight Layer.

LLM reasoning over already-aggregated results (never raw answers), keeping the
project's *code-first, LLM-last* discipline. Three configurable features:

* :func:`comment`        — flexible executive commentary (user picks the blocks).
* :func:`suggest_inputs` — code-detected data gaps + LLM-phrased next-step advice.
* :func:`compare`        — numeric diff of two analyses + LLM narrative.

Like the other agents, this one depends only on ``core``/``models`` types and the
parsing utilities, never on another agent's internals; it is runnable in isolation.
"""

from __future__ import annotations

from agents.insight_agent.commentary import comment
from agents.insight_agent.comparison import compare, compute_diff
from agents.insight_agent.options import BLOCK_KEYS, BLOCK_TITLES, InsightOptions
from agents.insight_agent.suggestions import detect_gaps, suggest_inputs

__all__ = [
    "comment",
    "compare",
    "compute_diff",
    "detect_gaps",
    "suggest_inputs",
    "InsightOptions",
    "BLOCK_KEYS",
    "BLOCK_TITLES",
]
