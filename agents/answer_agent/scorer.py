"""Similarity scoring for Agent 1 (zero-token fallback).

A cheap deterministic ratio used to order/illustrate free-text differences when the
LLM is not consulted (e.g. budget cap reached). The LLM verdict, when present, takes
precedence over this number.
"""

from __future__ import annotations

from difflib import SequenceMatcher


def text_similarity(a: str, b: str) -> float:
    a, b = (a or "").strip().casefold(), (b or "").strip().casefold()
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return round(SequenceMatcher(None, a, b).ratio(), 3)
