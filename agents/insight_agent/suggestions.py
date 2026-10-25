"""Feature 2 — data/workflow suggestions.

Code detects concrete gaps in the uploaded data (missing/partial reference, low sample
sizes, test sheets without a reference, missing groups). The LLM, when available,
phrases and prioritizes them and adds next-step advice. The gap detection itself costs
zero tokens, so it works in free mode.
"""

from __future__ import annotations

import re

from agents.insight_agent._common import extract_json, text_of, usage_from, zero_usage
from agents.insight_agent.prompt_loader import load_prompt
from core.models import QuestionType
from pipeline.parsers.excel_utils import normalize_question

_GROUP_RE = re.compile(r"групп[аы]\s*№?\s*(\d+)", re.IGNORECASE)


def _detect_groups(source_names) -> set[int]:
    nums: set[int] = set()
    for n in source_names or []:
        for m in _GROUP_RE.finditer(str(n)):
            nums.add(int(m.group(1)))
    return nums


def _nums(values) -> str:
    """[1, 2, 3, 4] → «1–4»; [1, 3] → «1, 3» (no Python list brackets in user text)."""
    v = sorted(set(values))
    if len(v) > 2 and v[-1] - v[0] == len(v) - 1:
        return f"{v[0]}–{v[-1]}"
    return ", ".join(str(x) for x in v)


def _plural(n: int, one: str, few: str, many: str) -> str:
    n = abs(n)
    if n % 100 in (11, 12, 13, 14):
        return many
    return one if n % 10 == 1 else few if n % 10 in (2, 3, 4) else many


def detect_gaps(course, result: dict, *, source_names=None, min_samples: int = 10) -> list[dict]:
    """Zero-token detection of concrete data gaps. Returns ``[{code, severity, message}]``."""
    answer = result.get("answer") or {}
    questions = answer.get("questions", [])
    gaps: list[dict] = []

    if not course.reference:
        gaps.append({
            "code": "reference_missing", "severity": "high",
            "message": "Эталон не загружен — открытые ответы проверяются без эталона. "
                       "Загрузите файл «Эталон ответов» для точной проверки.",
        })
    else:
        missing = [
            q.get("question_text", "")
            for q in questions
            if QuestionType.from_raw(q.get("type", "")).needs_semantic_check and q.get("wrong")
            and not course.reference.get(q.get("test_name"), {}).get(normalize_question(q.get("question_text", "")))
        ]
        if missing:
            gaps.append({
                "code": "reference_partial", "severity": "medium",
                "message": f"Для {len(missing)} {_plural(len(missing), 'открытого вопроса', 'открытых вопросов', 'открытых вопросов')} нет эталонного ответа — "
                           "проверка по смыслу ограничена. Дополните эталон.",
            })
        attempt_tests = {a.test_name for a in course.attempts}
        unmatched = sorted(attempt_tests - set(course.reference))
        if unmatched:
            tail = "…" if len(unmatched) > 5 else ""
            gaps.append({
                "code": "unmatched_tests", "severity": "medium",
                "message": f"Тесты без эталона: {', '.join(unmatched[:5])}{tail}. "
                           "Загрузите соответствующий эталон.",
            })

    low = [q for q in questions if 0 < q.get("answered", 0) < min_samples]
    if low:
        gaps.append({
            "code": "low_samples", "severity": "medium",
            "message": f"{len(low)} {_plural(len(low), 'вопрос имеет', 'вопроса имеют', 'вопросов имеют')} мало ответов (< {min_samples}) — "
                       "выводы по ним ненадёжны. Добавьте больше попыток или групп.",
        })

    groups = _detect_groups(source_names)
    if groups:
        missing_groups = sorted(set(range(1, max(groups) + 1)) - groups)
        if missing_groups:
            gaps.append({
                "code": "groups_missing", "severity": "info",
                "message": f"Загружены группы {_nums(groups)}, не хватает {_nums(missing_groups)}. "
                           "Дозагрузите остальные группы для полной картины.",
            })
        else:
            gaps.append({
                "code": "groups_more", "severity": "info",
                "message": f"Загружены группы {_nums(groups)}. Если есть ещё группы или "
                           "следующий курс — можно дозагрузить и сравнить анализы.",
            })

    return gaps


def suggest_inputs(course, result: dict, *, source_names=None, min_samples: int = 10, client=None) -> dict:
    """Detect gaps (code) and optionally narrate them (LLM).

    Returns ``{"gaps": [...], "narrative": text|None, "llm_usage": {...}}``.
    """
    gaps = detect_gaps(course, result, source_names=source_names, min_samples=min_samples)
    narrative = None
    usage = zero_usage()

    if client is not None and gaps:
        s = (result.get("answer") or {}).get("summary", {}) or {}
        stats = (
            f"Пользователей: {s.get('total_users')}, вопросов: {s.get('total_questions')}, "
            f"средний балл: {s.get('avg_score')}%."
        )
        spec = load_prompt("suggestions")
        user = spec["user_template"].format(
            stats=stats, gaps="\n".join(f"- {g['message']}" for g in gaps)
        )
        res = client.complete(spec["system"], user)
        narrative = text_of(extract_json(res.text).get("narrative")) or None
        usage = usage_from(res)

    return {"gaps": gaps, "narrative": narrative, "llm_usage": usage}
