"""Load editable YAML prompts for the insight agent (SPEC §3: prompts not inlined)."""

from __future__ import annotations

from pathlib import Path

import yaml

_DIR = Path(__file__).resolve().parent / "prompts"
_cache: dict[str, dict] = {}


def load_prompt(name: str) -> dict:
    """Return the parsed prompt spec ``prompts/<name>.yaml`` (cached)."""
    if name not in _cache:
        _cache[name] = yaml.safe_load((_DIR / f"{name}.yaml").read_text(encoding="utf-8")) or {}
    return _cache[name]
