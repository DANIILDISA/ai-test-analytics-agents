"""Deterministic, zero-token matching of a given answer to the reference (Agent 1).

A pre-filter run BEFORE the LLM: if an LMS-"wrong" free-text/numeric answer matches an
acceptable variant (or the inline correct answer) by one of four tiers, it is an LMS
false-negative we can credit without spending tokens. High-precision by design — it
overrides the LMS verdict, so the fuzzy threshold is deliberately strict (default 92).
The fuzzy tier is gated by `threshold`: setting it to 0 disables fuzzy matching entirely;
it is off by default in config because near-misses on spelling/paronym tests are wrong answers.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from rapidfuzz import fuzz

_SPLIT = re.compile(r"[,;\n]+")
_QUOTES = "\"'«»“”`"


def _norm(s: str) -> str:
    """casefold + ё→е + strip wrapping quotes/whitespace + collapse internal whitespace."""
    s = (s or "").replace("Ё", "Е").replace("ё", "е").casefold().strip()
    s = s.strip(_QUOTES).strip()
    return re.sub(r"\s+", " ", s)


def _as_number(s: str) -> float | None:
    """Parse a numeric answer tolerating spaces and a decimal comma; else None."""
    t = (s or "").strip().replace(" ", "").replace(" ", "").replace(" ", "").replace(",", ".")
    if not t:
        return None
    try:
        return float(t)
    except ValueError:
        return None


def _items(s: str) -> frozenset[str]:
    """Split a list answer on , ; or newlines into a set of normalized items."""
    return frozenset(_norm(p) for p in _SPLIT.split(s or "") if p.strip())


@dataclass
class Match:
    kind: str       # "exact" | "numeric" | "set" | "fuzzy"
    variant: str    # the candidate that matched
    score: float    # 100.0 for exact/numeric/set; the rapidfuzz ratio for fuzzy


def match_acceptable(
    given: str,
    acceptable: list[str],
    correct_sample: str = "",
    *,
    threshold: int = 92,
) -> Match | None:
    """Return the first matching tier (exact → numeric → set → fuzzy), or None."""
    candidates = [
        c for c in (list(acceptable) + ([correct_sample] if correct_sample else []))
        if c and c.strip()
    ]
    if not (given and given.strip()) or not candidates:
        return None

    ng = _norm(given)

    # 1. exact (normalized)
    for c in candidates:
        if ng == _norm(c):
            return Match("exact", c, 100.0)

    # 2. numeric equality
    gnum = _as_number(given)
    if gnum is not None:
        for c in candidates:
            cnum = _as_number(c)
            if cnum is not None and gnum == cnum:
                return Match("numeric", c, 100.0)

    # 3. order-insensitive set (list answers)
    gitems = _items(given)
    if len(gitems) >= 2:
        for c in candidates:
            if _items(c) == gitems:
                return Match("set", c, 100.0)

    # 4. fuzzy (typos / minor formatting) — disabled when threshold <= 0, because on
    # spelling/paronym tests a near-miss IS the wrong answer (those go to the LLM).
    if threshold > 0:
        best, best_c = 0.0, ""
        for c in candidates:
            sc = fuzz.ratio(ng, _norm(c))
            if sc > best:
                best, best_c = sc, c
        if best >= threshold:
            return Match("fuzzy", best_c, round(best, 1))

    return None
