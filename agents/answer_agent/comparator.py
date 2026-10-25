"""LLM review of LMS-wrong free-text / numeric answers (Agent 1).

The LMS already grades text (case- and ё/е-insensitive). This step asks the model
whether a *wrong*-marked free-form answer is nonetheless semantically acceptable
versus the reference — catching LMS false negatives — and returns a short Russian
reason. Called only for ``needs_semantic_check`` types, deduplicated and budget-capped
by the caller.
"""

from __future__ import annotations

import json

from models.base import LLMClient, LLMResult

# Bump when the prompt below changes — it is part of the cache key, so a new
# version transparently invalidates verdicts judged under the old wording.
PROMPT_VERSION = "2-strict"

_SYSTEM = (
    "Ты — методист, который СТРОГО проверяет ответы студентов на открытые вопросы. "
    "Сравни ответ студента с эталоном и реши, можно ли засчитать его как правильный "
    "по смыслу. Допустимы синонимы, иной порядок слов и незначительные опечатки; "
    "неполный ответ, искажение смысла, ответ не на тот вопрос или фактически другой "
    "ответ — НЕ засчитывай. При любом сомнении НЕ засчитывай. "
    "Отвечай строго в формате JSON, без пояснений."
)

# Inserted immediately before the reference answer in every prompt to push the
# model toward stricter matching (short answers were the main source of
# model-to-model disagreement, where leniency diverged).
_STRICT = (
    "Оценивай строго: засчитывай только при полном смысловом совпадении с эталоном; "
    "при сомнении — не засчитывай."
)


def _extract_json(text: str) -> dict:
    t = text.strip()
    if t.startswith("```"):
        t = t.strip("`")
        nl = t.find("\n")
        if nl != -1:
            t = t[nl + 1:]
    start, end = t.find("{"), t.rfind("}")
    if start != -1 and end != -1:
        t = t[start:end + 1]
    try:
        return json.loads(t)
    except (ValueError, TypeError):
        return {}


def _extract_json_array(text: str) -> list:
    t = text.strip()
    if t.startswith("```"):
        t = t.strip("`")
        nl = t.find("\n")
        if nl != -1:
            t = t[nl + 1:]
    start, end = t.find("["), t.rfind("]")
    if start != -1 and end != -1:
        t = t[start:end + 1]
    try:
        data = json.loads(t)
    except (ValueError, TypeError):
        return []
    return data if isinstance(data, list) else []


_BATCH_INSTRUCTION = (
    'Верни JSON-массив, по одному объекту на каждый номер, строго в формате: '
    '[{"i": 1, "acceptable": true|false, "reason": "краткое объяснение на русском"}]'
)


def review_answers_batch(
    client: LLMClient,
    *,
    question: str,
    givens: list[str],
    correct: str,
    acceptable: list[str],
) -> tuple[list[dict], LLMResult]:
    """Judge several of one question's wrong answers in a single call.

    Returns a verdict per given (aligned to ``givens``). A given whose index is
    absent from the model's array — or the whole batch on a parse failure — gets a
    verdict marked ``uncached`` so the caller does not persist a non-answer.
    """
    numbered = "\n".join(f"{i}. {g!r}" for i, g in enumerate(givens, 1))
    user = (
        f"Вопрос: {question}\n"
        f"{_STRICT}\n"
        f"Эталонный ответ: {correct!r}\n"
        f"Допустимые варианты: {acceptable}\n\n"
        f"Ответы студентов (по номерам):\n{numbered}\n\n"
        f"{_BATCH_INSTRUCTION}"
    )
    res = client.complete(_SYSTEM, user)
    by_i: dict[int, dict] = {}
    for obj in _extract_json_array(res.text):
        if isinstance(obj, dict) and "i" in obj:
            try:
                by_i[int(obj["i"])] = obj
            except (ValueError, TypeError):
                continue
    verdicts: list[dict] = []
    for idx in range(1, len(givens) + 1):
        obj = by_i.get(idx)
        if obj is None:
            verdicts.append({"acceptable": False, "reason": "(LLM недоступен)", "uncached": True})
        else:
            verdicts.append({
                "acceptable": bool(obj.get("acceptable", False)),
                "reason": (str(obj.get("reason", "")).strip()[:200] or "(нет объяснения)"),
            })
    return verdicts, res


def review_answer(
    client: LLMClient,
    *,
    question: str,
    given: str,
    correct: str,
    acceptable: list[str],
) -> tuple[dict, LLMResult]:
    user = (
        f"Вопрос: {question}\n"
        f"Ответ студента: {given!r}\n"
        f"{_STRICT}\n"
        f"Эталонный ответ: {correct!r}\n"
        f"Допустимые варианты: {acceptable}\n\n"
        'Верни JSON: {"acceptable": true|false, "reason": "краткое объяснение на русском"}'
    )
    res = client.complete(_SYSTEM, user)
    data = _extract_json(res.text)
    if not data:
        out = {"acceptable": False, "reason": "(LLM недоступен)", "uncached": True}
    else:
        out = {
            "acceptable": bool(data.get("acceptable", False)),
            "reason": (str(data.get("reason", "")).strip()[:200] or "(нет объяснения)"),
        }
    return out, res
