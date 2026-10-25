"""OpenRouter adapter (foreign group) via the OpenAI-compatible API.

Model id, base URL, key (by env-var name), reasoning toggle and sampling all come
from :class:`~core.config.ModelConfig` — nothing is hardcoded. ``reasoning`` is
disabled for reasoning-models (e.g. deepseek-v4-flash) to conserve tokens; OpenRouter
usage accounting is requested so ``LLMResult.cost`` is populated.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from openai import OpenAI

from models.base import LLMResult

if TYPE_CHECKING:
    from core.config import ModelConfig

_DEFAULT_BASE = "https://openrouter.ai/api/v1"
_HEADERS = {"HTTP-Referer": "https://localhost/testanalyzer", "X-Title": "TestAnalyzer"}


def _reasoning_extra(reasoning_enabled: bool) -> dict:
    """Build OpenRouter's ``extra_body`` (usage accounting + reasoning controls).

    When reasoning is disabled in config we send BOTH ``enabled: false`` and
    ``exclude: true``. Per OpenRouter's docs the disable flag is not honoured by
    every model (some always reason — deepseek emitted reasoning tokens despite
    ``enabled: false``), so ``exclude`` at least keeps reasoning text out of the
    response we must parse as strict JSON. Fully eliminating billed reasoning
    tokens requires choosing a non-reasoning model.
    """
    extra: dict = {"usage": {"include": True}}
    if not reasoning_enabled:
        extra["reasoning"] = {"enabled": False, "exclude": True}
    return extra


class OpenRouterClient:
    def __init__(self, mc: "ModelConfig") -> None:
        from core.config import ConfigError

        if not mc.api_key:
            raise ConfigError(
                "OpenRouter: пустой API-ключ (проверьте OPENROUTER_API_KEY в .env)"
            )
        self._mc = mc
        self._client = OpenAI(
            api_key=mc.api_key,
            base_url=mc.base_url or _DEFAULT_BASE,
            default_headers=_HEADERS,
        )

    @property
    def name(self) -> str:
        return f"openrouter:{self._mc.model}"

    def complete(self, system: str, user: str) -> LLMResult:
        extra = _reasoning_extra(self._mc.reasoning)
        resp = self._client.chat.completions.create(
            model=self._mc.model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            max_tokens=self._mc.max_tokens,
            temperature=self._mc.temperature,
            extra_body=extra,
        )
        choice = resp.choices[0]
        text = (choice.message.content or "").strip()

        prompt_tokens = completion_tokens = reasoning_tokens = 0
        cost = 0.0
        usage = resp.usage
        if usage is not None:
            prompt_tokens = usage.prompt_tokens or 0
            completion_tokens = usage.completion_tokens or 0
            extra_u = getattr(usage, "model_extra", None) or {}
            cost = float(extra_u.get("cost") or 0.0)
            ctd = getattr(usage, "completion_tokens_details", None)
            if ctd is not None:
                reasoning_tokens = getattr(ctd, "reasoning_tokens", 0) or 0

        return LLMResult(
            text=text,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            reasoning_tokens=reasoning_tokens,
            cost=cost,
        )
