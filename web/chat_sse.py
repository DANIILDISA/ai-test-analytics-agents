# web/chat_sse.py
"""Adapt one chat-agent turn (a Plan-1 ``LoopResult``) into a Server-Sent Events stream.

SSE event names are the spec §5 contract, exactly: ``status | card | token | confirm |
done | error``. A frame is ``event: <name>\\ndata: <json>\\n\\n``. ``stream_turn`` runs
the bounded loop once and yields frames in order; ``card`` events carry one card dict
from ``LoopResult.blocks``; ``confirm`` carries ``{name, arguments}``; ``done`` is the
last frame after the assistant message is persisted by the caller.
"""

from __future__ import annotations

import json
from typing import Iterator

#: The server->client event contract (spec §5 / D5). Order is the canonical listing.
#: ``tool`` (one tool-trace entry), ``budget`` (step budget exhausted) and ``stopped``
#: (user cancelled the turn) are the transparency events added for the live streaming path.
SSE_EVENTS: tuple[str, ...] = (
    "status", "tool", "card", "token", "confirm", "budget", "stopped", "done", "error",
)


def sse_frame(event: str, data: dict) -> str:
    """Format one SSE frame. Raises ValueError for an event outside the contract set."""
    if event not in SSE_EVENTS:
        raise ValueError(f"Недопустимое SSE-событие: {event!r}. Разрешены: {SSE_EVENTS}")
    # ensure_ascii=True (the json.dumps default): the test's exact-match branch expects
    # ASCII-escaped JSON on the wire (\uXXXX), which clients decode back identically.
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def frame_for_event(item: tuple[str, dict]) -> str:
    """Turn one ``(event, data)`` tuple yielded by ``loop.stream_turn`` into an SSE frame."""
    event, data = item
    return sse_frame(event, data)


# --- appended for Task 5 (LoopResult -> SSE event sequence) ---
from agents.chat_agent.loop import LoopResult

#: Russian status copy emitted while the model composes the final answer.
STATUS_THINKING = "Готовлю ответ…"
STATUS_DONE = "Готово."


def frames_for_result(result: LoopResult) -> Iterator[str]:
    """Yield SSE frames for one completed turn, in contract order.

    ``card`` blocks become ``card`` events; ``text`` blocks become ``token`` events
    (whole-block text — true token streaming arrives with the real adapter in Plan 3).
    A pending confirmation ends the turn with a ``confirm`` event and **no** ``done``
    (the turn resumes via /chat/confirm). Otherwise the turn ends with ``done`` carrying
    the ordered blocks so the client can render/persist faithfully.
    """
    yield sse_frame("status", {"text": STATUS_THINKING})

    if result.pending_confirmation is not None:
        # A confirm-gated tool paused the turn — but any NON-gated tools in the same turn
        # already ran (loop.py preserves them); surface their cards/text BEFORE the confirm
        # so they aren't silently lost while the user decides.
        for block in result.blocks:
            if block.get("type") == "card":
                yield sse_frame("card", {"card": block["card"]})
            elif block.get("type") == "text":
                yield sse_frame("token", {"text": block.get("text", "")})
        yield sse_frame("confirm", result.pending_confirmation)
        return

    for block in result.blocks:
        if block.get("type") == "card":
            yield sse_frame("card", {"card": block["card"]})
        elif block.get("type") == "text":
            yield sse_frame("token", {"text": block.get("text", "")})

    yield sse_frame("done", {"blocks": result.blocks})
