"""OpenRouter tool-calling client (foreign group) via native OpenAI function-calling.

Implements :class:`agents.chat_agent.protocol.ToolCallingClient` (``chat`` + a
``chat_stream`` generator) so the chat agent's loop is provider-agnostic (spec §4).
Reuses :func:`models.foreign.openrouter._reasoning_extra` and the same
:class:`~core.config.ModelConfig` as the single-shot :class:`OpenRouterClient`; the
single-shot ``complete()`` is left untouched for C1. Tool schemas arrive in the Plan 1
``{name, description, parameters}`` shape and are wrapped into OpenAI's
``tools=[{"type":"function","function":{...}}]`` form.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Iterator

from openai import OpenAI

from agents.chat_agent.protocol import AssistantTurn, ToolCall
from models.foreign.openrouter import _DEFAULT_BASE, _HEADERS, _reasoning_extra
from models.react import build_react_system, parse_react

if TYPE_CHECKING:
    from core.config import ModelConfig


def _lacks_tool_support(exc: Exception) -> bool:
    """True when an OpenRouter error means the model has no native function-calling.

    OpenRouter answers a tools request to a non-tool model with HTTP 404 / a message like
    "No endpoints found that support tool use". We detect that by substring so the client
    can transparently retry over the provider-agnostic ReAct text protocol — letting the
    live chat keep working even if the chat_agent model is swapped to one lacking tools.
    """
    msg = str(exc).lower()
    return "tool use" in msg or "tool_use" in msg or "does not support tools" in msg


def _as_openai_tools(tools: list[dict]) -> list[dict]:
    return [{
        "type": "function",
        "function": {
            "name": t["name"],
            "description": t.get("description", ""),
            "parameters": t.get("parameters", {"type": "object", "properties": {}}),
        },
    } for t in tools]


def _react_messages(messages: list[dict], tools: list[dict]) -> list[dict]:
    """Rewrite the agent message list for ReAct: tool schemas go into the system prompt and
    ``tool`` role messages become user-visible Observations (no native tool role is used)."""
    base = "\n\n".join(m.get("content", "") for m in messages if m.get("role") == "system")
    out: list[dict] = [{"role": "system", "content": build_react_system(base, tools)}]
    for m in messages:
        role = m.get("role")
        if role == "system":
            continue
        if role == "tool":
            name = m.get("name", "tool")
            out.append({"role": "user", "content": f"Observation ({name}): {m.get('content', '')}"})
        elif role == "assistant" and m.get("tool_calls"):
            # Re-express the loop's native tool-call turn as a ReAct Action line so the
            # text-protocol model sees the action it just took (no native tool_call_id here).
            action = m["tool_calls"][0]
            args = json.dumps(action.get("arguments", {}), ensure_ascii=False)
            out.append({"role": "assistant",
                        "content": f"Action: {action.get('name', '')}\nAction Input: {args}"})
        else:
            out.append({"role": role, "content": m.get("content", "") or ""})
    return out


def _decode_args(raw: str | None) -> dict:
    try:
        obj = json.loads(raw or "{}")
    except (ValueError, TypeError):
        return {}
    return obj if isinstance(obj, dict) else {}


def _as_openai_messages(messages: list[dict]) -> list[dict]:
    """Translate the loop's internal message list into the exact OpenAI chat shape.

    The loop carries an assistant tool-call turn as ``{role:"assistant", content,
    tool_calls:[{id, name, arguments(dict)}]}`` and each result as ``{role:"tool",
    tool_call_id, name, content}``. Strict OpenAI-compatible providers require the
    assistant ``tool_calls`` to use ``{id, type:"function", function:{name, arguments
    (JSON string)}}`` and each ``tool`` message to reference its ``tool_call_id``; we
    rewrite them here. Plain user/system/text-assistant messages pass through verbatim.
    """
    out: list[dict] = []
    for m in messages:
        role = m.get("role")
        calls = m.get("tool_calls") if role == "assistant" else None
        if role == "assistant" and calls:
            out.append({
                "role": "assistant",
                "content": m.get("content") or None,
                "tool_calls": [{
                    "id": c.get("id", ""),
                    "type": "function",
                    "function": {
                        "name": c.get("name", ""),
                        "arguments": json.dumps(c.get("arguments", {}), ensure_ascii=False),
                    },
                } for c in calls],
            })
        elif role == "tool":
            out.append({
                "role": "tool",
                "tool_call_id": m.get("tool_call_id", ""),
                "content": m.get("content", ""),
            })
        else:
            out.append(m)
    return out


class OpenRouterToolClient:
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

    def chat(self, messages: list[dict], tools: list[dict]) -> AssistantTurn:
        if not tools:
            # «No tools available» = a plain chat completion (the single-call light path):
            # OpenAI-compatible APIs reject tool_choice with an empty tools list.
            resp = self._client.chat.completions.create(
                model=self._mc.model,
                messages=_as_openai_messages(messages),
                max_tokens=self._mc.max_tokens,
                temperature=self._mc.temperature,
                extra_body=_reasoning_extra(self._mc.reasoning),
            )
            return AssistantTurn(text=(resp.choices[0].message.content or "").strip())
        try:
            resp = self._client.chat.completions.create(
                model=self._mc.model,
                messages=_as_openai_messages(messages),
                tools=_as_openai_tools(tools),
                tool_choice="auto",
                max_tokens=self._mc.max_tokens,
                temperature=self._mc.temperature,
                extra_body=_reasoning_extra(self._mc.reasoning),
            )
        except Exception as exc:  # noqa: BLE001
            if _lacks_tool_support(exc):
                return self._chat_react(messages, tools)
            raise
        message = resp.choices[0].message
        calls = getattr(message, "tool_calls", None) or []
        if calls:
            return AssistantTurn(tool_calls=[
                ToolCall(
                    name=c.function.name,
                    arguments=_decode_args(c.function.arguments),
                    id=getattr(c, "id", "") or "",
                )
                for c in calls
            ])
        return AssistantTurn(text=(message.content or "").strip())

    def _chat_react(self, messages: list[dict], tools: list[dict]) -> AssistantTurn:
        """ReAct fallback for OpenRouter models without native function-calling.

        Embeds the tool catalogue in the system prompt and parses an ``Action:/Final
        Answer:`` completion back into the same AssistantTurn the native path returns, so
        the agent loop cannot tell the two apart (same contract as the GigaChat client).
        """
        resp = self._client.chat.completions.create(
            model=self._mc.model,
            messages=_react_messages(messages, tools),
            max_tokens=self._mc.max_tokens,
            temperature=self._mc.temperature,
            extra_body=_reasoning_extra(self._mc.reasoning),
        )
        return parse_react((resp.choices[0].message.content or "").strip())

    def chat_stream(self, messages: list[dict], tools: list[dict]) -> Iterator[str]:
        """Yield text deltas for a streamed completion (for the later SSE endpoint).

        Tool-call deltas are not surfaced here: streaming is used for prose answers;
        the agent loop's tool decisions go through the non-streaming :meth:`chat`.
        """
        stream = self._client.chat.completions.create(
            model=self._mc.model,
            messages=_as_openai_messages(messages),
            tools=_as_openai_tools(tools),
            tool_choice="auto",
            max_tokens=self._mc.max_tokens,
            temperature=self._mc.temperature,
            stream=True,
            extra_body=_reasoning_extra(self._mc.reasoning),
        )
        for chunk in stream:
            choices = getattr(chunk, "choices", None) or []
            if not choices:
                continue
            delta = getattr(choices[0], "delta", None)
            piece = getattr(delta, "content", None) if delta else None
            if piece:
                yield piece
