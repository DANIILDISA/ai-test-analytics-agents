# models/react.py
"""Provider-independent ReAct text protocol for models without native tool-calling.

GigaChat has no function-calling, so we describe the tools in the system prompt and
ask the model to answer in a fixed ``Action: / Action Input: / Final Answer:`` shape
(spec §4, D8). ``build_react_system`` renders that prompt from the same tool-schema
dicts the agent loop already passes (``{name, description, parameters}`` — the Plan 1
``tools.py`` ``_SCHEMAS`` shape). ``parse_react`` turns one completion back into the
SAME :class:`agents.chat_agent.protocol.AssistantTurn` the native adapter produces, so
the agent loop cannot tell the providers apart. Degradation is graceful: a completion
with no parsable action is treated as a final answer (never raises).
"""

from __future__ import annotations

import json
import re
import uuid

from agents.chat_agent.protocol import AssistantTurn, ToolCall

_INSTRUCTIONS = """\
У тебя есть инструменты (перечислены ниже). Чтобы вызвать инструмент, ответь СТРОГО в формате:

Thought: <короткое рассуждение>
Action: <имя инструмента из списка>
Action Input: <аргументы в виде JSON-объекта>

После строки Action не пиши ничего лишнего. Дождись результата инструмента (он придёт
сообщением с ролью tool) и продолжи. Когда ответ готов и инструменты больше не нужны,
ответь так:

Thought: <короткое рассуждение>
Final Answer: <ответ пользователю на русском языке>

Не выдумывай числа: все цифры бери только из результатов инструментов."""

# Capture the value after each keyword up to the next keyword or end of string.
_ACTION_RE = re.compile(r"^[ \t]*Action[ \t]*:[ \t]*(.+?)[ \t]*$", re.IGNORECASE | re.MULTILINE)
_INPUT_RE = re.compile(
    r"Action\s+Input[ \t]*:[ \t]*(.*?)(?=(?:^[ \t]*(?:Thought|Action|Observation|Final\s+Answer)[ \t]*:)|\Z)",
    re.IGNORECASE | re.DOTALL | re.MULTILINE,
)
_FINAL_RE = re.compile(r"Final\s+Answer[ \t]*:[ \t]*(.*)\Z", re.IGNORECASE | re.DOTALL)
_FENCE_RE = re.compile(r"^```[a-zA-Z]*\s*|\s*```$", re.MULTILINE)
#: Conservative JSON-repair passes for malformed ``Action Input`` from weak models
#: (GigaChat ReAct): a trailing comma, 'single-quoted' strings, and unquoted object keys.
_TRAILING_COMMA_RE = re.compile(r",(\s*[}\]])")
_SINGLE_QUOTED_RE = re.compile(r"'([^']*)'")
_BAREWORD_KEY_RE = re.compile(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)")
#: Internal ReAct scaffolding the model sometimes emits without the full protocol — these
#: labels are reasoning markers, never meant for the user. Strip the label (keep the text).
_SCAFFOLD_RE = re.compile(
    r"^[ \t]*(?:Thought|Observation|Action(?:\s+Input)?)[ \t]*:[ \t]*", re.IGNORECASE | re.MULTILINE
)


def _strip_scaffolding(s: str) -> str:
    """Remove leaked ReAct labels (``Thought:``/``Observation:``) so internal-reasoning tags
    never reach the user when a weak model answers without the full ``Final Answer:`` shape."""
    return _SCAFFOLD_RE.sub("", s).strip()


def build_react_system(base_system: str, tools: list[dict]) -> str:
    """System prompt = the agent's base prompt + the tool catalogue + ReAct rules."""
    lines = ["Доступные инструменты:"]
    for t in tools:
        params = json.dumps(t.get("parameters", {}), ensure_ascii=False)
        lines.append(f"- {t['name']}: {t.get('description', '')} Параметры: {params}")
    catalogue = "\n".join(lines)
    return f"{base_system}\n\n{catalogue}\n\n{_INSTRUCTIONS}"


def _repair_json(s: str) -> str:
    """Conservative regex repair of common GigaChat JSON mistakes, applied in order:
    (a) drop a trailing comma before ``}``/``]``; (b) turn 'single-quoted' strings into
    "double-quoted"; (c) quote a bareword object key immediately before a colon. Single
    quotes are converted before keys so an already-single-quoted key isn't re-quoted."""
    s = _TRAILING_COMMA_RE.sub(r"\1", s)
    s = _SINGLE_QUOTED_RE.sub(r'"\1"', s)
    s = _BAREWORD_KEY_RE.sub(r'\1"\2"\3', s)
    return s


def _parse_input(raw: str) -> dict:
    """Best-effort: JSON object -> dict; otherwise wrap the raw string under 'input'."""
    cleaned = _FENCE_RE.sub("", raw).strip()
    if not cleaned:
        return {}
    try:
        obj = json.loads(cleaned)
    except (ValueError, TypeError):
        # Weak models emit almost-JSON (trailing comma, single quotes, unquoted keys).
        # Try a conservative repair before discarding the structure under "input".
        try:
            repaired = json.loads(_repair_json(cleaned))
        except (ValueError, TypeError):
            repaired = None
        if isinstance(repaired, dict):
            return repaired
        return {"input": cleaned}
    return obj if isinstance(obj, dict) else {"input": cleaned}


def parse_react(text: str) -> AssistantTurn:
    """Turn a completion string into an AssistantTurn (action wins over final answer)."""
    body = text or ""
    action = _ACTION_RE.search(body)
    if action:
        name = action.group(1).strip()
        inp = _INPUT_RE.search(body)
        arguments = _parse_input(inp.group(1)) if inp else {}
        # OpenAI-compatible providers (e.g. GigaChat) reject tool_calls / tool messages
        # with empty ids (HTTP 400), so every parsed action gets a fresh non-empty id.
        return AssistantTurn(tool_calls=[ToolCall(name=name, arguments=arguments, id=uuid.uuid4().hex)])

    final = _FINAL_RE.search(body)
    if final:
        return AssistantTurn(text=_strip_scaffolding(final.group(1)))

    # graceful degradation: no Action/Final Answer markers. The model often still prefixes a
    # «Thought:» — strip the scaffolding so its reasoning text isn't shown with the raw label.
    return AssistantTurn(text=_strip_scaffolding(body))
