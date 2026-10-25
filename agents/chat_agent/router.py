# agents/chat_agent/router.py
"""Cheap, deterministic router: does this question need the tool loop, or can it be
answered in ONE model call from the injected analysis digest («лёгкий путь»)?

GigaChat has no native tool-calling, so the emulated ReAct loop costs several slow calls and
produces template-like answers. Most methodologist questions («какой вопрос самый сложный»,
«сколько сдали», «почему провалили X») are answered by the digest alone. Only questions that
need data OUTSIDE the digest — other runs / comparison, groups, per-student details, a single
test's full breakdown, reports, a (re)run — go to the tool loop. No LLM call is spent on
routing; a wrong «light» guess self-corrects because the light prompt lets the model reply
``NEED_TOOLS`` (see :mod:`agents.chat_agent.prompt`), which escalates to the loop.
"""

from __future__ import annotations

import re

#: Questions that need data beyond the digest. Lower-cased substring/regex matches.
_TOOL_RE = re.compile(
    r"|".join(
        [
            # comparison / dynamics across runs
            r"сравн", r"разниц", r"динамик", r"тренд", r"по сравнению", r"предыдущ", r"прошл\w+ (анализ|прогон|запуск|раз|период)",
            r"раньше", r"изменил\w+ (по|относительно)", r"другим анализ", r"двух анализ", r"обоих анализ",
            # per-group breakdown
            r"групп",
            # per-student details
            r"слушател\w+", r"студент\w*", r"сотрудник\w*", r"кто (из|именно)", r"у кого",
            r"конкретн\w+ (человек|чел)", r"фио", r"табельн", r"худш\w+ (результат|слушател)", r"лучш\w+ (результат|слушател)",
            # one test's full breakdown (the digest only has aggregates per test)
            r"(промежуточн\w+|итогов\w+)\s+тест", r"тест\w*\s*№?\s*\d", r"по (каждому|всем) тест",
            # reports / exports
            r"отч[её]т", r"выгруз", r"excel", r"эксел", r"скача", r"сформируй", r"сгенерир",
            # (re)running an analysis, uploaded files
            r"запусти", r"перезапуст", r"проанализируй", r"загруж",
            # listing history
            r"список (прошл|анализ)", r"какие (есть )?анализы", r"все анализы", r"истори\w+ анализ",
        ]
    ),
    re.IGNORECASE,
)

#: Keywords that mean a staged-files turn is about (re)running an analysis.
_RUN_RE = re.compile(r"запусти|перезапуст|проанализ|эталон|файл|загруж|анализ", re.IGNORECASE)


#: «Сколько студентов/слушателей/человек …» is a COUNT, answered from the digest aggregates.
_COUNT_RE = re.compile(r"сколько\s+(?:всего\s+)?(?:студент\w*|слушател\w*|сотрудник\w*|человек|участник\w*)", re.IGNORECASE)


def needs_tools(message: str) -> bool:
    """True when the question (by wording) needs data the digest does not carry."""
    return bool(_TOOL_RE.search(_COUNT_RE.sub(" ", message or "")))


def use_light_path(message: str, *, n_runs: int, staged_uploads: int = 0) -> bool:
    """Decide the route for a turn.

    Light only when an analysis is attached and the question does not need tool data.
    Staged files with no analysis, or files plus a run/analysis wording, keep the tool loop
    (``run_analysis`` flow).
    """
    if n_runs <= 0:
        return False
    if staged_uploads and _RUN_RE.search(message or ""):
        return False
    return not needs_tools(message)


def merge_system_messages(messages: list[dict]) -> list[dict]:
    """Collapse every system message into ONE leading system message (plain-chat form).

    Providers/adapters treat only the first system message as the system prompt (the rest
    become user turns), which would dilute the instructions on the single-call path."""
    system = "\n\n".join(m.get("content", "") for m in messages if m.get("role") == "system")
    rest = [m for m in messages if m.get("role") != "system"]
    return ([{"role": "system", "content": system}] if system else []) + rest
