"""User-selectable options for the AI commentary (the flexibility principle).

The methodologist ticks which insight blocks they want before a run and may add a
free-text request. Nothing is forced: an empty selection means no LLM commentary runs.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Ordered insight blocks the commentary can produce. Keys are stable identifiers;
# titles are the Russian labels shown in the UI / report.
BLOCK_KEYS: tuple[str, ...] = ("diagnosis", "why_failed", "recommendations", "anomalies")
BLOCK_TITLES: dict[str, str] = {
    "diagnosis": "Коротко о результатах",
    "why_failed": "Почему вопросы провалены",
    "recommendations": "Рекомендации",
    "anomalies": "Аномалии и риски",
}


@dataclass
class InsightOptions:
    blocks: set[str] = field(default_factory=set)  # subset of BLOCK_KEYS
    custom: str = ""                               # free-text request
    enabled: bool = False                          # master toggle for LLM commentary

    @classmethod
    def from_list(cls, blocks=None, custom: str = "", enabled: bool | None = None) -> "InsightOptions":
        """Build from loose input (UI form / CLI). Unknown block keys are dropped.

        ``enabled`` defaults to True when anything was actually requested, so callers
        don't have to wire a separate flag if they don't want one.
        """
        bs = {b for b in (blocks or []) if b in BLOCK_KEYS}
        custom = (custom or "").strip()
        if enabled is None:
            enabled = bool(bs) or bool(custom)
        return cls(blocks=bs, custom=custom, enabled=enabled)

    @property
    def requested(self) -> list[str]:
        """Selected blocks in canonical order."""
        return [b for b in BLOCK_KEYS if b in self.blocks]

    @property
    def active(self) -> bool:
        """True when commentary should actually call the LLM."""
        return self.enabled and (bool(self.blocks) or bool(self.custom))
