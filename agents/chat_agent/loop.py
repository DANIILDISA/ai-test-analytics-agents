# agents/chat_agent/loop.py
"""The bounded tool-calling loop with the run_analysis confirmation gate.

Two entry points over the same logic:

* :func:`run_turn` — computes the WHOLE turn, then returns a ``LoopResult`` (the
  non-streaming path; kept intact for /chat/confirm and the existing tests).
* :func:`stream_turn` — a generator yielding ``(event, data)`` tuples LIVE as the
  turn unfolds (status → tool traces/cards → incremental answer tokens → done),
  so a methodologist can watch the agent think and stop it mid-flight.

The loop calls the client, executes any requested tools, appends their results both
to the model's message list and (as cards) to the ordered output blocks, and repeats
until the model gives a final answer or the effort step-budget is exhausted. Tools
listed in ``confirm_tools`` pause the loop (return/emit ``pending_confirmation``)
unless already approved via ``approved_tool``. (Spec D2/D5/D10/D12.)
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Callable, Iterator

from agents.chat_agent.effort import step_budget
from agents.chat_agent.prompt import ESCALATE_TOKEN
from agents.chat_agent.protocol import ToolCallingClient
from agents.chat_agent.router import merge_system_messages

_BUDGET_FALLBACK = "Не удалось завершить за отведённое число шагов. Уточните вопрос или повысьте режим (effort)."

#: Short Russian status emitted before each model call (the methodologist sees the
#: agent is thinking instead of staring at a frozen screen on the slow GigaChat model).
_STATUS_THINKING = "Думаю…"

#: Hint shown when the step budget runs out before a final answer (suggests raising effort).
_BUDGET_HINT = "Использовано все шаги. Попробуйте режим Высокий или уточните вопрос."

#: After this many tool ERRORS in a single turn we stop looping and finalize with what we
#: already gathered — instead of burning the rest of the budget on a tool the weak model
#: (GigaChat ReAct, no native function-calling) keeps misusing. Successes do NOT count.
_TOOL_ERROR_CAP = 3

#: Russian finalization when too many tool calls fail in one turn (suggests raising effort).
_TOOL_FAIL_FINALIZE = (
    "Несколько попыток инструментов не удались — отвечаю тем, что удалось получить, "
    "и предлагаю повысить режим (effort)."
)


def _unknown_tool_error(name: str, registry: dict) -> dict:
    """Error for a tool name absent from the registry. LISTS the available tool names so a
    weak model can self-correct on its next step instead of dead-ending on a name it
    hallucinated, e.g. «Неизвестный инструмент: X. Доступные: list_runs, query_stats, …»."""
    available = ", ".join(registry.keys())
    return {"error": f"Неизвестный инструмент: {name}. Доступные: {available}"}


def _is_tool_error(result) -> bool:
    """True when a tool returned an ``{"error": ...}`` dict (a failure, not a card/data)."""
    return isinstance(result, dict) and bool(result.get("error"))


def _recovery_note(result: dict) -> dict | None:
    """A THROWAWAY system note (never persisted) that classifies a tool ``{error}`` and
    suggests a concrete next move, steering a weak model toward recovery on its NEXT step.

    Returns ``None`` when ``result`` is not an error. The more specific compare-cases are
    checked before the broad «run_id» rule so «сравнивать сам с собой» / «укажите … run_id»
    map to «выбери другой прогон», not to «вызови list_runs»."""
    if not _is_tool_error(result):
        return None
    err = str(result.get("error", "")).lower()
    if "сам с собой" in err or ("укажите" in err and "run_id" in err):
        hint = "выбери другой прогон для сравнения и повтори вызов."
    elif "эталон" in err:
        hint = "спроси у пользователя точное имя файла-эталона."
    elif "не найден" in err or "run_id" in err:
        hint = "вызови list_runs, чтобы увидеть доступные прогоны, и повтори с верным run_id."
    else:
        hint = "переформулируй вызов или ответь тем, что уже известно."
    return {"role": "system", "content": f"Инструмент вернул ошибку: «{result['error']}». Дальше: {hint}"}


@dataclass
class LoopResult:
    blocks: list[dict] = field(default_factory=list)        # ordered [text|card]
    tool_trace: list[dict] = field(default_factory=list)    # {name, arguments, result}
    pending_confirmation: dict | None = None                # {name, arguments} if paused


def run_turn(client: ToolCallingClient, registry: dict, messages: list[dict], *,
             effort: str = "medium", confirm_tools: tuple[str, ...] = ("run_analysis",),
             approved_tool: str | None = None) -> LoopResult:
    budget = step_budget(effort)
    msgs = list(messages)
    res = LoopResult()
    schemas = [t["schema"] for t in registry.values()]
    recovery_notes: list[dict] = []  # throwaway hints staged by the previous step's tool errors
    error_count = 0                  # tool ERRORS this turn (successful tools don't count)

    def _is_gated(call) -> bool:
        # A confirm-gated tool that has not been approved this turn must pause the loop.
        return call.name in confirm_tools and approved_tool != call.name

    for _ in range(budget):
        # Carry any recovery hints from the previous step's tool errors into THIS model call
        # (throwaway: added for one call only, never appended to msgs so they never pile up).
        turn = client.chat(msgs + recovery_notes, schemas)
        recovery_notes = []

        if turn.is_final:
            res.blocks.append({"type": "text", "text": turn.text})
            return res

        # A turn may mix a confirm-gated call (e.g. run_analysis) with ordinary tool calls.
        # We must NOT drop the ordinary ones when we pause for confirmation: execute every
        # NON-gated call first, THEN pause on the gated one. (The caller — api.py — runs the
        # single approved tool on confirm; the single-gated confirm contract is preserved.)
        gated = next((call for call in turn.tool_calls if _is_gated(call)), None)
        runnable = [call for call in turn.tool_calls if not _is_gated(call)]

        # OpenAI tool-calling compliance: a `tool` message must be preceded by an assistant
        # message carrying the matching `tool_calls` (with ids). Append that assistant message
        # once for the runnable calls, THEN one tool message per call echoing its id. The gated
        # call is intentionally absent here — it has no tool result yet (it runs on confirm).
        if runnable:
            msgs.append({
                "role": "assistant",
                "content": turn.text or "",
                "tool_calls": [
                    {"id": call.id, "name": call.name, "arguments": call.arguments}
                    for call in runnable
                ],
            })

            for call in runnable:
                tool = registry.get(call.name)
                result = tool["fn"](call.arguments) if tool else _unknown_tool_error(call.name, registry)
                res.tool_trace.append({"name": call.name, "arguments": call.arguments, "result": result})

                if isinstance(result, dict) and "card" in result:
                    res.blocks.append({"type": "card", "card": result["card"]})

                msgs.append({
                    "role": "tool",
                    "tool_call_id": call.id,
                    "name": call.name,
                    "content": json.dumps(result, ensure_ascii=False),
                })

                # On a tool error: count it and stage a recovery hint for the model's next step.
                if _is_tool_error(result):
                    error_count += 1
                    rnote = _recovery_note(result)
                    if rnote is not None:
                        recovery_notes.append(rnote)

            # Too many tool failures this turn: stop burning the budget. Finalize with whatever
            # blocks were gathered plus a clear Russian message (suggests raising effort).
            if error_count >= _TOOL_ERROR_CAP:
                res.blocks.append({"type": "text", "text": _TOOL_FAIL_FINALIZE})
                return res

        # Pause AFTER the free tools have run, so their cards/traces survive (not lost).
        if gated is not None:
            res.pending_confirmation = {"name": gated.name, "arguments": gated.arguments}
            return res

    res.blocks.append({"type": "text", "text": _BUDGET_FALLBACK})
    return res


def _tool_summary(name: str, arguments: dict, result) -> str:
    """A short Russian one-liner for the «Ход рассуждений» trace: what the tool looked at
    or found, derived from name + arguments + result (no LLM). Errors surface verbatim so
    the methodologist sees WHY a step failed, not a silent gap."""
    if isinstance(result, dict) and result.get("error"):
        return f"{name}: ошибка — {result['error']}"
    args = arguments or {}
    rid = args.get("run_id") or ""
    if not rid and isinstance(result, dict):
        card = result.get("card")
        if isinstance(card, dict):
            rid = card.get("run_id") or ""
    rid_part = f" прогона {rid}" if rid else ""

    if name == "query_stats":
        labels = {
            "summary": "сводка",
            "critical": "критические вопросы",
            "attempts": "попытки и аномалии",
            "question": f"вопрос «{args.get('query', '')}»",
        }
        what = labels.get(args.get("slice", ""), f"срез {args.get('slice', '')}")
        return f"{name}: {what}{rid_part}"
    if name == "list_runs":
        n = len(result.get("data", [])) if isinstance(result, dict) else 0
        return f"{name}: список прошлых анализов ({n})"
    if name == "load_run":
        return f"{name}: сводка анализа{rid_part}"
    if name == "compare_runs":
        return f"{name}: сравнение прогонов {args.get('run_id_a', '')} и {args.get('run_id_b', '')}"
    if name == "run_analysis":
        return f"{name}: запуск анализа по приложенным файлам"
    return f"{name}: выполнено"


_CHUNK_RE = re.compile(r"\S+\s*")


def _chunk_text(text: str, group: int = 2) -> Iterator[str]:
    """Split an already-composed answer into a few token-sized chunks (~``group`` words each)
    for a progressive «typing» feel; concatenating the chunks reproduces ``text`` exactly."""
    toks = _CHUNK_RE.findall(text)
    if not toks:
        if text:
            yield text
        return
    for i in range(0, len(toks), group):
        yield "".join(toks[i : i + group])


_SCAFFOLD_PREFIX_RE = re.compile(r"^\s*(?:Thought|Observation)\s*:[^\n]*(?:\n|$)", re.IGNORECASE)
_FINAL_ANSWER_RE = re.compile(r"Final\s+Answer\s*:\s*", re.IGNORECASE)


def light_answer(client: ToolCallingClient, messages: list[dict]) -> str | None:
    """The «лёгкий путь»: ONE plain model call (no tools, no ReAct scaffolding) over the
    messages. Returns the answer text, or ``None`` when the caller should fall back to the
    tool loop — the model asked for more data (``NEED_TOOLS``), answered nothing, or
    unexpectedly requested a tool call.

    ``chat(messages, [])`` means «no tools available»: adapters then send a plain chat
    request. Every client is already wrapped with PII scrubbing at the factory, so this path
    is masked exactly like the tool loop."""
    turn = client.chat(merge_system_messages(messages), [])
    if turn.tool_calls:
        return None
    text = (turn.text or "").strip()
    m = _FINAL_ANSWER_RE.search(text)
    if m:
        text = text[m.end():].strip()
    text = _SCAFFOLD_PREFIX_RE.sub("", text, count=1).strip()
    if ESCALATE_TOKEN in text:
        rest = text.replace(ESCALATE_TOKEN, "").strip(" \t\r\n.!`'\"«»:-—")
        if len(rest) < 40:
            return None
        text = text.replace(ESCALATE_TOKEN, "").strip()
    return text or None


def stream_turn(
    client: ToolCallingClient,
    registry: dict,
    messages: list[dict],
    *,
    effort: str = "medium",
    confirm_tools: tuple[str, ...] = ("run_analysis",),
    approved_tool: str | None = None,
    cancel: Callable[[], bool] | None = None,
    light_messages: list[dict] | None = None,
) -> Iterator[tuple[str, dict]]:
    """Stream one chat turn LIVE as ``(event, data)`` tuples (the SHARED SSE CONTRACT).

    Mirrors :func:`run_turn`'s logic but yields as it goes so the UI can render the
    agent thinking. Internally accumulates the ordered ``blocks`` and the full
    ``tool_trace`` ({name, arguments, result}); both ride on the final ``("done", ...)``
    tuple so the caller can persist exactly what :func:`run_turn` would have produced.

    Events per turn, in order: ``status`` (before each model call) → ``tool``/``card``
    (one per executed tool) → ``token`` (the answer, INCREMENTALLY when the client exposes
    a ``chat_stream``, else one whole chunk) → ``done``. A confirm-gated unapproved tool
    ends with ``confirm`` (no done). An exhausted budget ends with ``budget`` then ``done``.
    A truthy ``cancel()`` between iterations ends with ``stopped`` (no done).

    ``light_messages`` (the context assembled WITHOUT tool hints) first tries the single-call
    «лёгкий путь» (:func:`light_answer`): the question is answered directly from the context
    digest with no tool loop and no tool trace. If the model reports it needs more data (or
    answers nothing), the turn falls through to the normal tool loop over ``messages``.
    """
    if light_messages:
        if cancel is not None and cancel():
            yield ("stopped", {})
            return
        yield ("status", {"text": _STATUS_THINKING})
        text = light_answer(client, light_messages)
        if text is not None:
            for chunk in _chunk_text(text):
                yield ("token", {"text": chunk})
            yield ("done", {"blocks": [{"type": "text", "text": text}], "tool_trace": []})
            return

    budget = step_budget(effort)
    msgs = list(messages)
    blocks: list[dict] = []
    tool_trace: list[dict] = []
    schemas = [t["schema"] for t in registry.values()]
    recovery_notes: list[dict] = []  # throwaway hints staged by the previous step's tool errors
    error_count = 0                  # tool ERRORS this turn (successful tools don't count)

    def _is_gated(call) -> bool:
        return call.name in confirm_tools and approved_tool != call.name

    for step in range(budget):
        # Cooperative cancellation: the methodologist hit «Стоп». End the turn cleanly.
        if cancel is not None and cancel():
            yield ("stopped", {})
            return

        yield ("status", {"text": _STATUS_THINKING})

        # Self-throttling hint: tell the model how many steps remain so a capable model can
        # wrap up early. A throwaway system note (NOT persisted into msgs, so it never piles up).
        remaining = budget - step
        note = {"role": "system", "content": (
            f"Осталось {remaining} шаг(ов). Если шагов мало — отвечай тем, что уже найдено, "
            "и предложи повысить режим (effort)."
        )}
        # Both the remaining-steps note AND any recovery hints staged by the previous step's
        # tool errors are throwaway: included for THIS call only, never appended to msgs.
        call_msgs = msgs + recovery_notes + [note]

        turn = client.chat(call_msgs, schemas)
        recovery_notes = []

        if turn.is_final:
            # Emit the ALREADY-PARSED answer in small chunks for a progressive «typing» feel —
            # WITHOUT a second model call. Using the adapter's chat_stream here would (a) re-query
            # the model (double cost — bad on the GigaChat free tier) and (b) on the ReAct path
            # stream the RAW «Thought:/Action:/Final Answer:» scaffolding straight to the user
            # (parse_react never runs on a token stream). turn.text is already clean for every
            # provider, so we chunk that. One call, no leak.
            text = turn.text or ""
            for chunk in _chunk_text(text):
                yield ("token", {"text": chunk})
            blocks.append({"type": "text", "text": text})
            yield ("done", {"blocks": blocks, "tool_trace": tool_trace})
            return

        # A turn may mix a confirm-gated call with ordinary ones: run every NON-gated call
        # first (surfacing its trace + card), THEN pause on the gated one — never drop the
        # free tools' results while the user decides. (Mirrors run_turn.)
        gated = next((call for call in turn.tool_calls if _is_gated(call)), None)
        runnable = [call for call in turn.tool_calls if not _is_gated(call)]

        if runnable:
            msgs.append({
                "role": "assistant",
                "content": turn.text or "",
                "tool_calls": [
                    {"id": call.id, "name": call.name, "arguments": call.arguments}
                    for call in runnable
                ],
            })

            for call in runnable:
                tool = registry.get(call.name)
                result = tool["fn"](call.arguments) if tool else _unknown_tool_error(call.name, registry)
                tool_trace.append({"name": call.name, "arguments": call.arguments, "result": result})

                # Trace entry FIRST (one line of what the tool looked at), then its card if any.
                yield ("tool", {"name": call.name, "summary": _tool_summary(call.name, call.arguments, result)})
                if isinstance(result, dict) and "card" in result:
                    blocks.append({"type": "card", "card": result["card"]})
                    yield ("card", {"card": result["card"]})

                msgs.append({
                    "role": "tool",
                    "tool_call_id": call.id,
                    "name": call.name,
                    "content": json.dumps(result, ensure_ascii=False),
                })

                # On a tool error: count it and stage a recovery hint for the model's next step.
                if _is_tool_error(result):
                    error_count += 1
                    rnote = _recovery_note(result)
                    if rnote is not None:
                        recovery_notes.append(rnote)

            # Too many tool failures this turn: stop looping. Surface the finalization as an
            # ("error", …) event (already in the SSE contract), then close with ("done", …)
            # carrying whatever cards/text were gathered (mirrors run_turn's finalize).
            if error_count >= _TOOL_ERROR_CAP:
                yield ("error", {"text": _TOOL_FAIL_FINALIZE})
                blocks.append({"type": "text", "text": _TOOL_FAIL_FINALIZE})
                yield ("done", {"blocks": blocks, "tool_trace": tool_trace})
                return

        if gated is not None:
            yield ("confirm", {"name": gated.name, "arguments": gated.arguments})
            return

    # Budget exhausted with no final answer: tell the user (with a raise-effort hint),
    # then close carrying whatever cards/text were already found so nothing is lost.
    yield ("budget", {"used": budget, "total": budget, "hint": _BUDGET_HINT})
    blocks.append({"type": "text", "text": _BUDGET_FALLBACK})
    yield ("done", {"blocks": blocks, "tool_trace": tool_trace})
