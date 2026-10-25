"""Shared LLM interface + result type so model groups are interchangeable.

Every adapter (foreign / russian) implements :class:`LLMClient`, so the agents and
pipeline depend only on this Protocol — never on a concrete provider. ``LLMResult``
carries token/cost usage so the pipeline can enforce the per-course token budget.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass
class LLMResult:
    text: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    reasoning_tokens: int = 0
    cost: float = 0.0  # USD, when the provider reports it


@runtime_checkable
class LLMClient(Protocol):
    @property
    def name(self) -> str:
        """Stable identifier, e.g. ``"openrouter:deepseek/deepseek-v4-flash"``."""
        ...

    def complete(self, system: str, user: str) -> LLMResult:
        """One non-streaming completion for a (system, user) prompt pair."""
        ...
