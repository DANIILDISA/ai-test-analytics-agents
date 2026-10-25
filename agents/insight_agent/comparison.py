"""Feature 3 — compare two analyses.

Code computes the numeric diff (which questions improved / worsened / appeared /
disappeared, and how the summary moved) by matching questions on normalized text. The
LLM, when available, narrates the change. The diff itself costs zero tokens.
"""

from __future__ import annotations

from agents.insight_agent._common import extract_json, text_of, usage_from, zero_usage
from agents.insight_agent.prompt_loader import load_prompt
from pipeline.parsers.excel_utils import normalize_question

_DELTA = 0.05  # min correct-rate change to count as improved / worsened (not noise)


def _qmap(answer: dict) -> dict:
    out: dict = {}
    for q in answer.get("questions", []):
        # Key on normalized TEXT alone. Within a run, questions are already unique-by-text
        # (merged via _merge_questions_by_text), which keeps the test_name of the FIRST sheet
        # it saw — that varies with processing order, so keying on test_name would make the
        # SAME question hash differently between runs and show up as both "new" and "dropped".
        out[normalize_question(q.get("question_text", ""))] = q
    return out


def _crit_count(answer: dict) -> int:
    return sum(1 for q in answer.get("questions", []) if q.get("critical"))


def compute_diff(result_a: dict, result_b: dict, *, delta_threshold: float = _DELTA) -> dict:
    """Numeric, token-free diff of two analysis results (A = earlier, B = later)."""
    a = result_a.get("answer") or {}
    b = result_b.get("answer") or {}
    ma, mb = _qmap(a), _qmap(b)
    common = ma.keys() & mb.keys()

    improved, worsened, stable = [], [], 0
    for key in common:
        ra = ma[key].get("correct_rate", 0.0) or 0.0
        rb = mb[key].get("correct_rate", 0.0) or 0.0
        d = round(rb - ra, 4)
        item = {
            "question_text": mb[key].get("question_text") or ma[key].get("question_text"),
            "a_rate": ra, "b_rate": rb, "delta": d,
        }
        if d > delta_threshold:
            improved.append(item)
        elif d < -delta_threshold:
            worsened.append(item)
        else:
            stable += 1
    improved.sort(key=lambda x: x["delta"], reverse=True)
    worsened.sort(key=lambda x: x["delta"])

    sa, sb = a.get("summary", {}) or {}, b.get("summary", {}) or {}
    return {
        "course_a": result_a.get("course_id"),
        "course_b": result_b.get("course_id"),
        "summary_a": sa,
        "summary_b": sb,
        "summary_delta": {
            "avg_score": round((sb.get("avg_score") or 0) - (sa.get("avg_score") or 0), 2),
            "total_users": (sb.get("total_users") or 0) - (sa.get("total_users") or 0),
            "critical": _crit_count(b) - _crit_count(a),
        },
        "common_count": len(common),
        "stable_count": stable,
        "improved": improved,
        "worsened": worsened,
        "new": [{"question_text": mb[k].get("question_text"), "b_rate": mb[k].get("correct_rate")} for k in (mb.keys() - ma.keys())],
        "dropped": [{"question_text": ma[k].get("question_text"), "a_rate": ma[k].get("correct_rate")} for k in (ma.keys() - mb.keys())],
    }


def _format_diff(diff: dict) -> str:
    d = diff["summary_delta"]
    lines = [
        f"Средний балл: {diff['summary_a'].get('avg_score')}% → {diff['summary_b'].get('avg_score')}% "
        f"(изменение {d['avg_score']:+}).",
        f"Критических вопросов изменилось на {d['critical']:+}.",
        f"Общих вопросов: {diff['common_count']}, без изменений: {diff['stable_count']}.",
        f"Улучшилось: {len(diff['improved'])}, ухудшилось: {len(diff['worsened'])}, "
        f"новых: {len(diff['new'])}, пропало: {len(diff['dropped'])}.",
    ]
    for it in diff["improved"][:8]:
        lines.append(f"+ улучшение {it['delta']*100:+.0f}%: {str(it['question_text'])[:100]}")
    for it in diff["worsened"][:8]:
        lines.append(f"- ухудшение {it['delta']*100:+.0f}%: {str(it['question_text'])[:100]}")
    return "\n".join(lines)


def compare(result_a: dict, result_b: dict, options=None, client=None) -> dict:
    """Compute the diff and (optionally) an LLM narrative.

    Returns ``{"diff": {...}, "narrative": text|None, "llm_usage": {...}}``.
    The narrative runs only when a ``client`` is given and ``options`` is None or enabled.
    """
    diff = compute_diff(result_a, result_b)
    narrative = None
    usage = zero_usage()

    want_narrative = client is not None and (options is None or getattr(options, "enabled", True))
    if want_narrative:
        spec = load_prompt("comparison")
        user = spec["user_template"].format(diff=_format_diff(diff))
        res = client.complete(spec["system"], user)
        narrative = text_of(extract_json(res.text).get("narrative")) or None
        usage = usage_from(res)

    return {"diff": diff, "narrative": narrative, "llm_usage": usage}
