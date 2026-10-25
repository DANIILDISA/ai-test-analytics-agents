"""Feature 1 — flexible LLM commentary over a course's aggregated results.

One cheap call over aggregated statistics (summary + critical questions + common
errors) — never raw answers. Returns only the insight blocks the methodologist asked
for (plus an optional free-text answer), keeping the *code-first, LLM-last* discipline.
"""

from __future__ import annotations

from agents.insight_agent._common import extract_json, text_of, usage_from, zero_usage
from agents.insight_agent.options import InsightOptions
from agents.insight_agent.prompt_loader import load_prompt


def format_stats(answer: dict, *, max_questions: int = 15) -> str:
    """Compact, token-light rendering of the Agent-1 aggregates for the prompt."""
    s = answer.get("summary", {}) or {}
    lines = [
        f"Пользователей: {s.get('total_users')}, вопросов: {s.get('total_questions')}, "
        f"средний балл: {s.get('avg_score')}%, реальных попыток: {s.get('real_attempts')}, "
        f"брошенных: {s.get('abandoned')}."
    ]
    crit = sorted(
        (q for q in answer.get("questions", []) if q.get("critical")),
        key=lambda x: x.get("correct_rate", 0.0),
    )
    lines.append(f"Критических вопросов (доля верных ниже порога): {len(crit)}.")
    for q in crit[:max_questions]:
        errs = "; ".join(
            f"{e.get('answer')} (×{e.get('count')})" for e in (q.get("common_errors") or [])[:3]
        )
        rate = round(q.get("correct_rate", 0.0) * 100)
        lines.append(f"- [{rate}% верных] {str(q.get('question_text', ''))[:120]} | частые ошибки: {errs or '—'}")
    return "\n".join(lines)


def comment(result: dict, options: InsightOptions, client) -> dict:
    """Produce the requested commentary blocks for one course.

    Returns ``{"blocks": {key: text}, "custom": text|None, "llm_usage": {...}}``.
    No-op (no call, zero usage) when ``options`` is inactive or there is no client.
    """
    if not options.active or client is None:
        return {"blocks": {}, "custom": None, "llm_usage": zero_usage()}

    answer = result.get("answer") or {}
    spec = load_prompt("commentary")
    requested = options.requested

    instr_lines = [f'- "{b}": {spec["blocks"][b].strip()}' for b in requested]
    keys = list(requested)
    if options.custom:
        instr_lines.append(f'- "custom": {options.custom}')
        keys.append("custom")

    user = spec["user_template"].format(
        stats=format_stats(answer),
        instructions="\n".join(instr_lines),
        keys=", ".join(f'"{k}"' for k in keys),
    )
    res = client.complete(spec["system"], user)
    data = extract_json(res.text)

    blocks = {b: text_of(data.get(b)) for b in requested if text_of(data.get(b))}
    custom = None
    if options.custom:
        custom = text_of(data.get("custom")) or None
    return {"blocks": blocks, "custom": custom, "llm_usage": usage_from(res)}
