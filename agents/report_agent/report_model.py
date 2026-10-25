"""Content model of the Word / PDF report (one source for both renderers).

``build_report_model(result, meta)`` turns a saved run (``core.history`` ``report.json`` +
its index entry) into plain Python data: title block, KPI tiles, the four AI blocks, the
table of critical questions and a short methodology note. The renderers
(``docx_report`` / ``pdf_report``) only lay it out — no numbers are computed there.

Defensive on purpose: older runs may lack ``time`` / ``insights`` / ``input_report`` and any
field may be missing — a gap becomes «—», never an exception.
"""

from __future__ import annotations

import re
from datetime import datetime

from agents.insight_agent._common import text_of

REPORT_TITLE = "Отчёт по результатам тестирования"

#: The four AI blocks, in the order and under the titles shown on the results screen.
AI_BLOCKS: tuple[tuple[str, str], ...] = (
    ("diagnosis", "Коротко о результатах"),
    ("why_failed", "Почему вопросы провалены"),
    ("recommendations", "Рекомендации"),
    ("anomalies", "Аномалии и риски"),
)

#: Rows of the critical-questions table above this are cut (the rest is in the Excel export).
MAX_CRITICAL_ROWS = 40

_BULLET = re.compile(r"^\s*(?:[•\-–—*]+|\d+[.)])\s+")


def _plural(n: int, one: str, few: str, many: str) -> str:
    n = abs(int(n))
    if n % 100 in (11, 12, 13, 14):
        return many
    return one if n % 10 == 1 else few if n % 10 in (2, 3, 4) else many


def parse_block(text: str) -> list[tuple[str, str]]:
    """AI block text → ``[("p"|"li", text), …]``: list lines become bullets, the rest paragraphs."""
    out: list[tuple[str, str]] = []
    for raw in text_of(text).splitlines():
        line = raw.replace("**", "").replace("__", "").strip()
        if not line:
            continue
        if _BULLET.match(line):
            out.append(("li", _BULLET.sub("", line, count=1).strip()))
        else:
            out.append(("p", line))
    return out


def pretty_answer(raw) -> str:
    """Stored answer → readable: empty parts («; ; ;») become «не заполнено»."""
    t = str(raw or "").strip()
    if not t:
        return "не заполнено"
    parts = re.split(r"\s*;\s*", t)
    if len(parts) > 1 and not any(p.strip() for p in parts):
        return "не заполнено"
    return "; ".join(p.strip() if p.strip() else "не заполнено" for p in parts)


def pretty_correct(raw) -> str | None:
    """Correct answer for the report; None when the reference has no value for it
    (empty, or only separators like «; ; ;»). Blank parts of a multi-part answer read
    «нет в эталоне» - «не заполнено» is wording for what a learner left empty."""
    t = str(raw or "").strip()
    if not t:
        return None
    parts = re.split(r"\s*;\s*", t)
    if not any(p.strip() for p in parts):
        return None
    return "; ".join(p.strip() if p.strip() else "нет в эталоне" for p in parts)


def _clip(text: str, limit: int = 280) -> str:
    """Very long answer options are cut so one row cannot fill a page."""
    text = text.strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _fmt_num(v, digits: int = 1) -> str:
    if v is None:
        return "—"
    try:
        f = float(v)
    except (TypeError, ValueError):
        return "—"
    if digits == 0 or f == int(f):
        return str(int(round(f)))
    return f"{f:.{digits}f}".replace(".", ",")


def _fmt_date(created_at: str | None) -> str:
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})", created_at or "")
    if m:
        return f"{m[3]}.{m[2]}.{m[1]} {m[4]}:{m[5]}"
    return datetime.now().strftime("%d.%m.%Y %H:%M")


def _pass_share(result: dict, pass_score: float) -> tuple[str, str | None]:
    """(«NN%», detail) — share of listeners whose best score reached ``pass_score``."""
    scores = [
        s["best_score"]
        for s in ((result.get("time") or {}).get("students") or [])
        if isinstance(s.get("best_score"), (int, float))
    ]
    if not scores:
        return "—", None
    passed = sum(1 for v in scores if v >= pass_score)
    return f"{round(passed / len(scores) * 100)}%", f"{passed} из {len(scores)}"


def _thresholds() -> dict:
    """critical_correct_rate / min_samples / pass_score from config.yaml (defaults if unreadable)."""
    try:
        from core.config import load_config

        t = load_config(require_key=False).thresholds
        return {
            "critical": float(t.critical_correct_rate),
            "min_samples": int(t.min_samples),
            "pass_score": float(t.pass_score),
        }
    except Exception:  # noqa: BLE001 — a report must still render without a readable config
        return {"critical": 0.5, "min_samples": 10, "pass_score": 75.0}


def build_report_model(result: dict, meta: dict | None = None) -> dict:
    result = result or {}
    meta = meta or {}
    th = _thresholds()
    answer = result.get("answer") or {}
    summary = answer.get("summary") or {}
    questions = answer.get("questions") or []
    critical = sorted(
        (q for q in questions if q.get("critical")),
        key=lambda q: q.get("correct_rate") if isinstance(q.get("correct_rate"), (int, float)) else 0,
    )

    course = str(result.get("course_id") or meta.get("course_id") or "").strip()
    if course.lower() == "анализ":
        course = ""
    name = str(meta.get("name") or "").strip() or course or "Анализ тестирования"

    group_labels = [g.get("label") for g in (result.get("groups") or []) if g.get("label")]
    group_labels = group_labels or [g for g in (meta.get("groups") or []) if g]

    users = summary.get("total_users")
    n_questions = summary.get("total_questions")
    pass_value, pass_detail = _pass_share(result, th["pass_score"])
    kpis = [
        {"label": "Реальные попытки", "value": _fmt_num(summary.get("real_attempts"), 0), "hint": None},
        {
            "label": "Средний балл",
            "value": f"{_fmt_num(summary.get('avg_score'))}%" if summary.get("avg_score") is not None else "—",
            "hint": None,
        },
        {
            "label": f"Доля прошедших (от {_fmt_num(th['pass_score'], 0)}%)",
            "value": pass_value,
            "hint": pass_detail,
        },
        {"label": "Критические вопросы", "value": str(len(critical)), "hint": None},
    ]
    scope = []
    if users is not None:
        scope.append(f"{users} {_plural(users, 'слушатель', 'слушателя', 'слушателей')}")
    if n_questions is not None:
        scope.append(f"{n_questions} {_plural(n_questions, 'вопрос', 'вопроса', 'вопросов')}")

    ai_blocks = []
    blocks = ((result.get("insights") or {}).get("commentary") or {}).get("blocks") or {}
    for key, title in AI_BLOCKS:
        items = parse_block(blocks.get(key) or "")
        if items:
            ai_blocks.append({"key": key, "title": title, "items": items})
    custom = ((result.get("insights") or {}).get("commentary") or {}).get("custom")
    if custom and str(custom).strip():
        ai_blocks.append({"key": "custom", "title": "Ответ на ваш запрос", "items": parse_block(custom)})

    rows = []
    for q in critical[:MAX_CRITICAL_ROWS]:
        errs = q.get("common_errors") or []
        wrong = None
        if errs:
            e = errs[0]
            wrong = f"{_clip(pretty_answer(e.get('answer')))} (×{e.get('count', 0)})"
        rate = q.get("correct_rate")
        rows.append({
            "question": _clip(str(q.get("question_text") or "—"), 400),
            "rate": f"{round(rate * 100)}%" if isinstance(rate, (int, float)) else "—",
            "wrong": wrong,
            "correct": _clip(correct_text) if (correct_text := pretty_correct(q.get("correct_answer"))) else None,
            "key_suspect": bool(q.get("key_suspect")),
        })

    rep = result.get("input_report") or {}
    notes = []
    for d in rep.get("skipped") or []:
        reason = str(d.get("reason") or "")
        notes.append(reason if f"«{d.get('file')}»" in reason else f"Файл «{d.get('file')}» не учтён — {reason}")
    notes += [str(x) for x in (rep.get("limitations") or [])]

    crit_pct = round(th["critical"] * 100)
    method = [
        "Доля верных ответов считается по завершённым попыткам; брошенные попытки в неё не входят.",
        f"Вопрос считается критическим, если верно ответили менее {crit_pct}% слушателей "
        f"(при числе ответов не меньше {th['min_samples']}).",
        f"«Прошедшим» считается слушатель, чей лучший балл не ниже {_fmt_num(th['pass_score'], 0)}%.",
        "Ответы со свободным вводом сверяются с эталоном по правилам, спорные случаи может оценивать языковая модель.",
    ]
    if ai_blocks:
        method.append(
            "Раздел «ИИ-выводы» подготовлен языковой моделью по рассчитанным данным; "
            "его стоит проверить методисту перед использованием."
        )
    if questions and not any(q.get("correct_answer") for q in questions):
        method.append("В загруженных файлах нет эталонных ответов — верные ответы в таблице не указаны.")

    return {
        "title": REPORT_TITLE,
        "name": name,
        "course": course or None,
        "date": _fmt_date(meta.get("created_at")),
        "groups": group_labels,
        "scope": " · ".join(scope),
        "kpis": kpis,
        "ai_enabled": bool(ai_blocks),
        "ai_blocks": ai_blocks,
        "critical": rows,
        "critical_total": len(critical),
        "critical_more": max(0, len(critical) - MAX_CRITICAL_ROWS),
        "data_notes": notes,
        "method": method,
    }
