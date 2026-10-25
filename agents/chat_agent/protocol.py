# agents/chat_agent/protocol.py
"""The loop's only LLM dependency: a provider-agnostic tool-calling interface.

A concrete client (OpenRouter native function-calling, GigaChat ReAct fallback) is
built in a later plan; the loop depends only on this Protocol, so it is fully
testable against a fake. Non-streaming here; streaming/SSE is a later plan.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable


@dataclass
class ToolCall:
    name: str
    arguments: dict
    id: str = ""


@dataclass
class AssistantTurn:
    """One model turn: either tool calls to run, or a final text answer."""

    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)

    @property
    def is_final(self) -> bool:
        return not self.tool_calls


@runtime_checkable
class ToolCallingClient(Protocol):
    def chat(self, messages: list[dict], tools: list[dict]) -> AssistantTurn:
        """Given the running message list and tool schemas, return the next turn."""
        ...
