"""Shared helpers for the insight agent: JSON extraction + LLM usage accounting.

Kept local to the package so the agent depends only on ``core``/``models`` types and
its own internals (agent-isolation rule), not on another agent's private helpers.
"""

from __future__ import annotations

import json

from models.base import LLMResult


def zero_usage() -> dict:
    return {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "reasoning_tokens": 0, "cost": 0.0}


def usage_from(res: LLMResult) -> dict:
    return {
        "calls": 1,
        "prompt_tokens": res.prompt_tokens,
        "completion_tokens": res.completion_tokens,
        "reasoning_tokens": res.reasoning_tokens,
        "cost": round(res.cost, 6),
    }


def text_of(value: object) -> str:
    """Model-reply field → clean text.

    A model sometimes answers with a JSON list (or a Python-list-looking string) instead of
    prose; ``str(list)`` would leak brackets and quotes into the report. Lists become a
    bulleted block (one «- пункт» per line), dicts become «ключ: значение» lines."""
    import ast

    if value is None:
        return ""
    if isinstance(value, str):
        t = value.strip()
        if len(t) > 1 and t[0] == "[" and t[-1] == "]":
            try:
                parsed = ast.literal_eval(t)
            except (ValueError, SyntaxError):
                return t
            if isinstance(parsed, (list, tuple)):
                return text_of(list(parsed))
        return t
    if isinstance(value, (list, tuple)):
        items = [text_of(v) for v in value]
        return "\n".join(f"- {i}" for i in items if i)
    if isinstance(value, dict):
        rows = [f"{k}: {text_of(v)}" for k, v in value.items()]
        return "\n".join(r for r in rows if r.strip(": "))
    return str(value).strip()


def extract_json(text: str) -> dict:
    """Best-effort parse of a JSON object from a model reply (tolerates code fences)."""
    t = (text or "").strip()
    if t.startswith("```"):
        t = t.strip("`")
        nl = t.find("\n")
        if nl != -1:
            t = t[nl + 1:]
    start, end = t.find("{"), t.rfind("}")
    if start != -1 and end != -1:
        t = t[start:end + 1]
    try:
        data = json.loads(t)
    except (ValueError, TypeError):
        return {}
    return data if isinstance(data, dict) else {}
