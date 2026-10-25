# models/russian/gigachat_tools.py
"""GigaChat ReAct tool-calling client (russian group).

GigaChat has no native function-calling, so this client implements
:class:`agents.chat_agent.protocol.ToolCallingClient` via the text-protocol fallback
in :mod:`models.react` (spec §4, D8): the tool schemas are embedded in the system
prompt and the model is asked to answer in ``Action: / Action Input: / Final Answer:``
shape, parsed back into the SAME :class:`AssistantTurn` the native OpenRouter adapter
produces. Construction/auth and the temperature-omit-on-zero rule mirror the
single-shot :class:`~models.russian.gigachat.GigaChatClient`; its ``complete()`` stays
untouched (C1 uses it). ``chat_stream`` lands in the next task.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from agents.chat_agent.protocol import AssistantTurn
from models.react import build_react_system, parse_react

if TYPE_CHECKING:
    from core.config import ModelConfig

_DEFAULT_SYSTEM = (
    "Ты — аналитик результатов тестирования. Отвечай на русском языке и используй "
    "только числа из результатов инструментов."
)


def _split_messages(messages: list[dict]) -> tuple[str, list[dict]]:
    """Separate the system text from the conversation messages.

    EVERY system message (agent prompt, per-turn analysis context, loop notes) is joined into
    the one system prompt. Previously only the first was the system prompt and the rest were
    replayed as USER turns, so the model answered the grounding context / hint text instead
    of the user's actual question."""
    systems = [m.get("content", "") for m in messages if m.get("role") == "system" and m.get("content")]
    rest = [m for m in messages if m.get("role") != "system"]
    return ("\n\n".join(systems) if systems else _DEFAULT_SYSTEM), rest


def _render_turn(m: dict) -> tuple[str, str]:
    """Map an agent message to a (gigachat-role, content) pair.

    Tool-result messages have no GigaChat role, so we fold them into a USER turn
    formatted as an ``Observation`` the ReAct model can read.
    """
    role = m.get("role")
    if role == "tool":
        name = m.get("name", "tool")
        return "user", f"Observation ({name}): {m.get('content', '')}"
    if role == "assistant":
        calls = m.get("tool_calls")
        if calls:
            # Re-express the loop's native tool-call turn as a ReAct Action line so the
            # text-protocol model sees the action it just took.
            action = calls[0]
            args = json.dumps(action.get("arguments", {}), ensure_ascii=False)
            return "assistant", f"Action: {action.get('name', '')}\nAction Input: {args}"
        return "assistant", m.get("content", "") or ""
    return "user", m.get("content", "") or ""


class GigaChatReActClient:
    def __init__(self, mc: "ModelConfig") -> None:
        from models.russian._resilient import ResilientGigaChat

        self._mc = mc
        self._rg = ResilientGigaChat(mc)  # raises ConfigError on empty key / missing SDK

    @property
    def name(self) -> str:
        return f"gigachat:{self._mc.model}"

    def _build_chat(self, messages: list[dict], tools: list[dict], model: str | None = None):
        from gigachat.models import Chat, Messages, MessagesRole

        base, rest = _split_messages(messages)
        # No tools = plain chat (the single-call light path): no ReAct catalogue/format rules.
        system = build_react_system(base, tools) if tools else base
        sdk_messages = [Messages(role=MessagesRole.SYSTEM, content=system)]
        for m in rest:
            role, content = _render_turn(m)
            sdk_role = MessagesRole.ASSISTANT if role == "assistant" else MessagesRole.USER
            sdk_messages.append(Messages(role=sdk_role, content=content))

        kwargs: dict = {"messages": sdk_messages, "max_tokens": self._mc.max_tokens}
        if model:
            kwargs["model"] = model
        if self._mc.temperature and self._mc.temperature > 0:
            kwargs["temperature"] = self._mc.temperature
        return Chat(**kwargs)

    def chat(self, messages: list[dict], tools: list[dict]) -> AssistantTurn:
        resp = self._rg.chat(lambda model: self._build_chat(messages, tools, model))
        text = (resp.choices[0].message.content or "").strip()
        return parse_react(text)

    def chat_stream(self, messages: list[dict], tools: list[dict]):
        """Yield text deltas for a streamed completion (for the later SSE endpoint).

        Uses the SDK's ``stream`` generator with the same ReAct prompt as :meth:`chat`;
        tool-call decisions still go through non-streaming :meth:`chat`.
        """
        for chunk in self._rg.stream(lambda model: self._build_chat(messages, tools, model)):
            choices = getattr(chunk, "choices", None) or []
            if not choices:
                continue
            delta = getattr(choices[0], "delta", None)
            piece = getattr(delta, "content", None) if delta else None
            if piece:
                yield piece
