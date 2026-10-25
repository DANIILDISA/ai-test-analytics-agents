"""Persistent JSON answer cache for Agent 1.

Keyed by (model, normalised question, given answer, correct answer), so identical
free-text judgements are never paid for twice — across reruns and across courses.
Pass ``path=None`` for an in-memory-only cache (dedup within a single run).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

_SEP = "\x1f"


class AnswerCache:
    def __init__(self, path: str | Path | None) -> None:
        self.path = Path(path) if path is not None else None
        self._data: dict[str, dict] = {}
        self._dirty = False
        if self.path is not None and self.path.exists():
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    self._data = loaded
            except (ValueError, OSError):
                self._data = {}

    @staticmethod
    def make_key(
        *, model: str, question: str, given: str, correct: str, prompt_version: str = ""
    ) -> str:
        # Key on the SCRUBBED text (what the model actually sees), so PII never keys the cache.
        from core.pii_scrubber import scrub

        question, given, correct = (scrub(x)[0] for x in (question, given, correct))
        raw = _SEP.join((model, question, given, correct, prompt_version))
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]

    def get(self, key: str) -> dict | None:
        return self._data.get(key)

    def set(self, key: str, verdict: dict) -> None:
        self._data[key] = verdict
        self._dirty = True

    def save(self) -> None:
        if self.path is None or not self._dirty:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(self._data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        self._dirty = False
