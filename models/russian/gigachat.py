"""GigaChat adapter (russian group) over the official ``gigachat`` SDK.

Implements the shared :class:`~models.base.LLMClient` Protocol so it is
interchangeable with the foreign adapters. The SDK owns the OAuth token lifecycle
(30-min access token) and ships the Минцифры root CA. Model id, scope, sampling and
TLS verification all come from :class:`~core.config.ModelConfig` — nothing hardcoded.

GigaChat requires ``temperature`` strictly > 0, so a configured ``0.0`` is omitted
(the API would otherwise return HTTP 422). The free tier reports token usage but no
USD cost, so ``LLMResult.cost`` stays 0.0.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from models.base import LLMResult

if TYPE_CHECKING:
    from core.config import ModelConfig


class GigaChatClient:
    def __init__(self, mc: "ModelConfig") -> None:
        from models.russian._resilient import ResilientGigaChat

        self._mc = mc
        self._rg = ResilientGigaChat(mc)  # raises ConfigError on empty key / missing SDK

    @property
    def name(self) -> str:
        # Cache keys use this: the *requested* primary model, so verdicts are never
        # shared between different model tiers.
        return f"gigachat:{self._mc.model}"

    def complete(self, system: str, user: str) -> LLMResult:
        from gigachat.models import Chat, Messages, MessagesRole

        def build(model: str):
            kwargs: dict = {
                "messages": [
                    Messages(role=MessagesRole.SYSTEM, content=system),
                    Messages(role=MessagesRole.USER, content=user),
                ],
                "max_tokens": self._mc.max_tokens,
                "model": model,
            }
            if self._mc.temperature and self._mc.temperature > 0:
                kwargs["temperature"] = self._mc.temperature
            return Chat(**kwargs)

        resp = self._rg.chat(build)
        choice = resp.choices[0]
        text = (choice.message.content or "").strip()

        usage = getattr(resp, "usage", None)
        prompt_tokens = getattr(usage, "prompt_tokens", 0) or 0
        completion_tokens = getattr(usage, "completion_tokens", 0) or 0

        return LLMResult(
            text=text,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            cost=0.0,
        )
