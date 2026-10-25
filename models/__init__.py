"""LLM provider adapters, grouped by neural-network family.

The user selects a group before running the pipeline; results from both groups
must be comparable, so each adapter exposes the same :class:`~models.base.LLMClient`
interface and is chosen via :func:`get_client` (config-driven, never hard-coded):

* ``russian`` — РФ models (GigaChat, YandexGPT, …).
* ``foreign`` — foreign models (GPT-4o, Claude, Gemini, … via OpenRouter).

NOTE: this package holds *model adapters*, NOT data models -- the Pydantic data
models live in ``core.models``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from models.base import LLMClient, LLMResult

if TYPE_CHECKING:
    from core.config import AppConfig, ModelConfig

__all__ = ["LLMClient", "LLMResult", "get_client", "build_tool_client"]


def get_client(config: "AppConfig") -> LLMClient:
    """Return the LLM client for the active model group (provider factory).

    Always wrapped in :class:`models.scrubbing.ScrubbingClient`: PII never reaches the model."""
    from models.scrubbing import ScrubbingClient

    return ScrubbingClient(_raw_client(config))


def _raw_client(config: "AppConfig") -> LLMClient:
    from core.config import ConfigError

    mc = config.active_model
    provider = mc.provider.lower()
    if provider == "openrouter":
        from models.foreign.openrouter import OpenRouterClient

        return OpenRouterClient(mc)
    if provider == "gigachat":  # Phase 3
        from models.russian.gigachat import GigaChatClient

        return GigaChatClient(mc)
    raise ConfigError(f"Неизвестный провайдер модели: {mc.provider!r}")


def build_tool_client(mc: "ModelConfig"):
    """Tool-calling chat client, always wrapped with PII / student-id scrubbing."""
    from models.scrubbing import ScrubbingToolClient

    return ScrubbingToolClient(_raw_tool_client(mc))


def _raw_tool_client(mc: "ModelConfig"):
    """Return the tool-calling chat client for a resolved per-component ModelConfig.

    Mirrors :func:`get_client` but produces an
    :class:`agents.chat_agent.protocol.ToolCallingClient`: OpenRouter via native
    function-calling, GigaChat via the ReAct text-protocol fallback (spec §4, D8). The
    chat-agent component's ModelConfig is passed in directly (not the whole AppConfig),
    so multiple providers can be active at once (spec §3).
    """
    from core.config import ConfigError

    provider = mc.provider.lower()
    if provider == "openrouter":
        from models.foreign.openrouter_tools import OpenRouterToolClient

        return OpenRouterToolClient(mc)
    if provider == "gigachat":
        from models.russian.gigachat_tools import GigaChatReActClient

        return GigaChatReActClient(mc)
    raise ConfigError(f"Неизвестный провайдер модели: {mc.provider!r}")
