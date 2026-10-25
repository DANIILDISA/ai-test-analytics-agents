"""PII-scrubbing wrappers applied at the single factory point (models/__init__.py).

Ported by copy from продукт-2 (llm/scrubbing_client.py), extended for the tool-calling
chat client. Everything crossing to the model is masked: email/phone/FIO-like text, and
student identifiers (numeric LMS ids, UUIDs) -> stable «Слушатель N» pseudonyms. The
mapping stays local; pseudonyms in the model's reply / tool arguments are restored so the
tools and UI keep working with real ids.
"""

from __future__ import annotations

from core.pii_scrubber import Pseudonymizer, content_from_course, content_from_run
from models.base import LLMResult


class _ContextMixin:
    """Course context for the scrubber: names that are COURSE CONTENT (questions, options,
    etalon, reference) stay readable for the model; student identities are always masked.
    ``_pseudo`` is set by the concrete client."""

    _pseudo: Pseudonymizer

    def learn_course(self, course) -> None:
        """From a parsed ``CourseData`` (analysis pipeline)."""
        self._pseudo.learn(*content_from_course(course))

    def learn_run(self, run: dict | None) -> None:
        """From a stored analysis result (chat, tools, comparison)."""
        if run:
            self._pseudo.learn(*content_from_run(run))

    def learn_texts(self, texts=(), identities=()) -> None:
        self._pseudo.learn(texts, identities)


def learn(client, *, course=None, run=None) -> None:
    """Feed course context to ``client`` when it is a scrubbing wrapper (no-op for anything else)."""
    if not isinstance(client, _ContextMixin):
        return
    if course is not None:
        client.learn_course(course)
    if run is not None:
        client.learn_run(run)


class ScrubbingClient(_ContextMixin):
    """Wraps an LLMClient (complete(system, user)); masks both texts before delegating."""

    def __init__(self, inner) -> None:
        self._inner = inner
        self._pseudo = Pseudonymizer()

    @property
    def name(self) -> str:
        return self._inner.name

    def __getattr__(self, item):  # delegate anything else
        return getattr(self._inner, item)

    def complete(self, system: str, user: str, *args, **kwargs) -> LLMResult:
        return self._inner.complete(self._pseudo.mask(system), self._pseudo.mask(user), *args, **kwargs)


class ScrubbingToolClient(_ContextMixin):
    """Wraps a ToolCallingClient (chat / chat_stream); masks every message sent out."""

    def __init__(self, inner) -> None:
        self._inner = inner
        self._pseudo = Pseudonymizer()

    @property
    def name(self) -> str:
        return self._inner.name

    def __getattr__(self, item):
        return getattr(self._inner, item)

    @property
    def pseudonyms(self) -> dict[str, str]:
        """real id -> «Слушатель N» (local only)."""
        return dict(self._pseudo.forward)

    def chat(self, messages: list[dict], tools: list[dict]):
        turn = self._inner.chat(self._pseudo.mask_obj(list(messages)), tools)
        turn.text = self._pseudo.restore(turn.text or "")
        for call in turn.tool_calls:
            call.arguments = self._pseudo.restore_obj(call.arguments)
        return turn

    def chat_stream(self, messages: list[dict], tools: list[dict]):
        for piece in self._inner.chat_stream(self._pseudo.mask_obj(list(messages)), tools):
            yield self._pseudo.restore(piece)
