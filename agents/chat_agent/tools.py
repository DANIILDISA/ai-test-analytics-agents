# agents/chat_agent/tools.py
"""The chat agent's tools over existing C1 data.

Read tools return ``{"card": <render-ready>, "data": <raw>}`` (spec D12: numbers
from code, never the LLM) or ``{"error": <msg>}``. ``build_registry`` binds the
history root, the active run id, and the (injected) re-run callable so the loop can
dispatch by name. Richer slices (distribution, risk bands) arrive with E2.
"""

from __future__ import annotations

from pathlib import Path

from core import history
from agents.report_agent.generator import render_text


def _pct(rate: float | None) -> str:
    return f"{(rate or 0.0) * 100:.1f}%"


def _echo_rid(card: dict, run_id: str) -> dict:
    """Echo WHICH run a read-card was built from, so the model and user can verify the
    answered run in a multi-run chat (guards the silent «answered run #1» failure, #6).
    Always machine-readable via ``card["run_id"]``; on stats cards it is also surfaced as
    a small visible «Прогон» metric."""
    if not run_id or not isinstance(card, dict):
        return card
    card["run_id"] = str(run_id)
    if card.get("type") == "stats":
        card.setdefault("link", {"href": f"/results?run={run_id}", "text": "Открыть отчёт"})
    return card


def list_runs(filters: dict | None, *, root: Path | str = history.DEFAULT_ROOT) -> dict:
    runs = history.list_runs(root)
    items = [
        {"id": m["id"], "name": m.get("name"), "course_id": m.get("course_id"),
         "avg_score": (m.get("summary") or {}).get("avg_score"),
         "critical": (m.get("summary") or {}).get("critical")}
        for m in runs
    ]
    # No user-facing card: list_runs is an internal lookup the model uses to FIND runs (then
    # narrates the relevant ones in text). Rendering the whole index as a card spammed the chat
    # with a wall of every analysis (R3 follow-up). The model still sees `data` via the tool msg.
    return {"data": items}


def load_run(run_id: str, *, root: Path | str = history.DEFAULT_ROOT) -> dict:
    result = history.load_run(run_id, root)
    if result is None:
        return {"error": f"Анализ {run_id} не найден."}
    return {"card": _echo_rid(_summary_card(result), run_id),
            "data": result.get("answer", {}).get("summary", {})}


def _summary_card(result: dict) -> dict:
    s = (result.get("answer") or {}).get("summary", {}) or {}
    crit = sum(1 for q in (result.get("answer") or {}).get("questions", []) if q.get("critical"))
    return {
        "type": "stats",
        "title": "Сводка анализа",
        "metrics": [
            {"label": "Средний балл", "value": f"{s.get('avg_score')}%"},
            {"label": "Пользователи", "value": str(s.get("total_users"))},
            {"label": "Вопросы", "value": str(s.get("total_questions"))},
            {"label": "Реальные попытки", "value": str(s.get("real_attempts"))},
            {"label": "Критические", "value": str(crit)},
        ],
    }


def query_stats(run_id: str, slice: str, *, query: str = "",
                root: Path | str = history.DEFAULT_ROOT) -> dict:
    result = history.load_run(run_id, root)
    if result is None:
        return {"error": f"Анализ {run_id} не найден."}
    answer = result.get("answer") or {}
    questions = answer.get("questions", [])

    if slice == "summary":
        return {"card": _echo_rid(_summary_card(result), run_id), "data": answer.get("summary", {})}

    if slice == "critical":
        crit = [q for q in questions if q.get("critical")]
        items = [{"text": q.get("question_text"), "value": _pct(q.get("correct_rate"))} for q in crit]
        return {"card": _echo_rid({"type": "list", "title": "Критические вопросы", "items": items}, run_id),
                "data": crit}

    if slice == "attempts":
        t = result.get("time") or {}
        return {"card": _echo_rid({"type": "stats", "title": "Попытки", "metrics": [
            {"label": "Брошено, %", "value": str(t.get("abandoned_rate"))},
            {"label": "Аномальные студенты", "value": str(len(t.get("attempt_anomalies", [])))},
        ]}, run_id), "data": t}

    if slice == "question":
        q = _find_question(questions, query)
        if q is None:
            return {"error": f"Вопрос по запросу «{query}» не найден."}
        return {"card": _echo_rid({"type": "stats", "title": q.get("question_text"), "metrics": [
            {"label": "Верных", "value": _pct(q.get("correct_rate"))},
            {"label": "Ответили", "value": str(q.get("answered"))},
            {"label": "Неверных", "value": str(q.get("wrong"))},
        ]}, run_id), "data": q}

    return {"error": f"Неизвестный срез: {slice}"}


def _find_question(questions: list[dict], query: str) -> dict | None:
    ql = (query or "").strip().lower()
    if not ql:
        return None
    for q in questions:
        if ql in str(q.get("question_text", "")).lower() or ql == str(q.get("question_id")):
            return q
    return None


# --- append to agents/chat_agent/tools.py ---
from agents.insight_agent import compute_diff


def compare_runs(run_id_a: str, run_id_b: str, *, root: Path | str = history.DEFAULT_ROOT) -> dict:
    # Validate ids FIRST: an empty string slipped past the falsy self-compare guard and turned
    # into a generic «не найден», hiding the real cause. Be explicit (#6).
    if not run_id_a or not run_id_b:
        return {"error": "Укажите два анализа для сравнения (run_id)."}
    if run_id_a == run_id_b:
        return {"error": "Нельзя сравнивать прогон сам с собой — укажите другой прогон для сравнения."}
    a = history.load_run(run_id_a, root)
    b = history.load_run(run_id_b, root)
    if a is None or b is None:
        return {"error": "Один из анализов для сравнения не найден."}
    diff = compute_diff(a, b)
    sa, sb = diff["summary_a"], diff["summary_b"]
    d = diff["summary_delta"]
    crit_a = sum(1 for q in (a.get("answer") or {}).get("questions", []) if q.get("critical"))
    crit_b = sum(1 for q in (b.get("answer") or {}).get("questions", []) if q.get("critical"))
    rows = [
        {"label": "Средний балл", "a": sa.get("avg_score"), "b": sb.get("avg_score"), "delta": d["avg_score"]},
        {"label": "Пользователи", "a": sa.get("total_users"), "b": sb.get("total_users"), "delta": d["total_users"]},
        {"label": "Критические", "a": crit_a, "b": crit_b, "delta": d["critical"]},
    ]
    return {
        "card": {
            "type": "compare",
            "title": "Сравнение анализов",
            "a_label": a.get("name") or run_id_a,
            "b_label": b.get("name") or run_id_b,
            "rows": rows,
            # Echo the resolved ids so the user/model can verify WHICH runs were compared (#6).
            "run_id_a": run_id_a,
            "run_id_b": run_id_b,
        },
        "data": diff,
    }


def _effective_calls(params: dict) -> int:
    """LLM grading budget the run is effectively given — mirrors web.app._agent_rerun's
    ``int(params.get("max_llm_calls", 0))``. 0 ⇒ CODE-ONLY: no ИИ-разбор свободных ответов."""
    try:
        return int(params.get("max_llm_calls", 0) or 0)
    except (TypeError, ValueError):
        return 0


def run_analysis(params: dict, *, rerun=None, uploads=None) -> dict:
    """Run an analysis over the files attached to this chat. Confirm-gating happens in the
    loop; by the time this runs the action is already approved. ``rerun`` and ``uploads`` are
    injected (``rerun`` wired to web.service.run_analysis, ``uploads`` to the thread's staged
    files). Without a re-run callable or attached files there is nothing to analyse."""
    if rerun is None:
        return {"error": "Запуск анализа недоступен в этом контексте."}
    if not uploads:
        return {"error": "Нет приложенных файлов — попросите пользователя загрузить .xlsx в чат."}
    result = rerun(params, uploads)
    if result.get("error"):
        return result

    # Lead with the actual numbers, not just «started»: the user should immediately SEE the
    # key results of the run they just triggered (P1-B). Build a briefing from the result.
    answer = result.get("answer") or {}
    summary = answer.get("summary") or {}
    metrics = []
    if summary:
        crit = sum(1 for q in (answer.get("questions") or []) if q.get("critical"))
        metrics.extend([
            {"label": "Средний балл", "value": f"{summary.get('avg_score')}%"},
            {"label": "Пользователи", "value": str(summary.get("total_users"))},
            {"label": "Вопросы", "value": str(summary.get("total_questions"))},
            {"label": "Критические", "value": str(crit)},
        ])
    # KEEP the run_id echo so the user/model can verify WHICH run this card is about (#6) —
    # and so a stub result (no summary/answer) still yields at least one valid metric.

    # DATA-QUALITY FLAGS: surface parsing/quality warnings (малая выборка, отсутствие эталона)
    # so the methodologist sees them up front instead of trusting numbers blindly. First 1-2.
    for w in (result.get("warnings") or [])[:2]:
        metrics.append({"label": "Внимание", "value": str(w)})

    rid = result.get("run_id")
    card = {"type": "stats", "title": "Анализ готов", "metrics": metrics}
    if rid:
        card["run_id"] = str(rid)
        card["link"] = {"href": f"/results?run={rid}", "text": "Открыть полный отчёт"}
    return {"card": card, "data": result}


# --- P3 analyst toolset: tests / groups / students / trends / question-errors ---
# Each tool is grounded in the loaded run data, returns {card, data}, echoes the run id
# (``_echo_rid``), and reuses ONLY the "stats"/"list" card types so the frontend needs no
# change. Every one degrades to a clear Russian note (never a crash) on missing/old data —
# a run without groups, without the students rollup, or without per-test medians.

_STUDENT_STATUS = {"completed": "завершил", "abandoned": "бросил"}


def _questions(result: dict) -> list[dict]:
    return (result.get("answer") or {}).get("questions") or []


def list_tests(run_id: str, *, root: Path | str = history.DEFAULT_ROOT) -> dict:
    """One «list» row per distinct test_name: вопросов, критических и медиана балла."""
    result = history.load_run(run_id, root)
    if result is None:
        return {"error": f"Анализ {run_id} не найден."}
    medians = {str(t.get("test_name")): t.get("median_score")
               for t in (result.get("time") or {}).get("tests") or []}
    order: list[str] = []
    by_test: dict[str, dict] = {}
    for q in _questions(result):
        tn = q.get("test_name") or "—"
        if tn not in by_test:
            by_test[tn] = {"count": 0, "critical": 0}
            order.append(tn)
        by_test[tn]["count"] += 1
        if q.get("critical"):
            by_test[tn]["critical"] += 1
    items, data = [], []
    for tn in order:
        info = by_test[tn]
        median = medians.get(tn)
        median_str = f"{median}%" if median is not None else "н/д"
        items.append({"text": tn,
                      "value": f"{info['count']} вопросов, {info['critical']} крит., медиана {median_str}"})
        data.append({"test_name": tn, "questions": info["count"],
                     "critical": info["critical"], "median_score": median})
    card = {"type": "list", "title": "Тесты в анализе", "items": items}
    if not items:
        card["note"] = "В этом анализе нет вопросов с привязкой к тесту."
    return {"card": _echo_rid(card, run_id), "data": data}


def _filter_by_test(questions: list[dict], test_name: str) -> list[dict]:
    """Questions whose ``test_name`` (or membership in their ``tests`` list) matches — exact
    or substring, case-insensitive — so the model can pass a slightly loose test name."""
    tn = (test_name or "").strip().lower()
    if not tn:
        return []
    out = []
    for q in questions:
        names = [str(q.get("test_name", ""))] + [str(t) for t in (q.get("tests") or [])]
        names = [n.lower() for n in names if n]
        if any(tn == n for n in names) or any(tn in n for n in names):
            out.append(q)
    return out


def query_by_test(run_id: str, test_name: str, slice: str = "critical", *,
                  root: Path | str = history.DEFAULT_ROOT) -> dict:
    """One test's slice: critical (its critical questions) or summary (avg correct_rate,
    вопросов, критических). Clear note if the test isn't found."""
    result = history.load_run(run_id, root)
    if result is None:
        return {"error": f"Анализ {run_id} не найден."}
    matched = _filter_by_test(_questions(result), test_name)
    if not matched:
        note = f"Тест «{test_name}» не найден в этом анализе."
        return {"card": _echo_rid({"type": "list", "title": f"Тест: {test_name}",
                                   "items": [], "note": note}, run_id), "data": []}
    if slice == "summary":
        rates = [q.get("correct_rate") for q in matched if q.get("correct_rate") is not None]
        avg_rate = sum(rates) / len(rates) if rates else 0.0
        crit = sum(1 for q in matched if q.get("critical"))
        card = {"type": "stats", "title": f"Тест: {test_name}", "metrics": [
            {"label": "Средняя доля верных", "value": _pct(avg_rate)},
            {"label": "Вопросов", "value": str(len(matched))},
            {"label": "Критических", "value": str(crit)},
        ]}
        return {"card": _echo_rid(card, run_id), "data": matched}
    crit_qs = [q for q in matched if q.get("critical")]
    items = [{"text": q.get("question_text"), "value": f"доля верных {_pct(q.get('correct_rate'))}"}
             for q in crit_qs]
    card = {"type": "list", "title": f"Критические — {test_name}", "items": items}
    if not items:
        card["note"] = f"В тесте «{test_name}» нет критических вопросов."
    return {"card": _echo_rid(card, run_id), "data": crit_qs}


def list_groups(run_id: str, *, root: Path | str = history.DEFAULT_ROOT) -> dict:
    """One «list» row per group (multi-file run); a clear note for a single-file run."""
    result = history.load_run(run_id, root)
    if result is None:
        return {"error": f"Анализ {run_id} не найден."}
    groups = result.get("groups") or []
    if not groups:
        card = {"type": "list", "title": "Группы", "items": [],
                "note": "Анализ без разбивки по группам."}
        return {"card": _echo_rid(card, run_id), "data": []}
    items = []
    for g in groups:
        gs = (g.get("answer") or {}).get("summary") or {}
        gcrit = sum(1 for q in (g.get("answer") or {}).get("questions") or [] if q.get("critical"))
        label = g.get("label") or g.get("name") or "группа"
        items.append({"text": label,
                      "value": f"пользователей {gs.get('total_users')}, "
                               f"средний балл {gs.get('avg_score')}%, крит. {gcrit}"})
    return {"card": _echo_rid({"type": "list", "title": "Группы", "items": items}, run_id),
            "data": groups}


def _find_group(groups: list[dict], group_label: str) -> dict | None:
    gl = (group_label or "").strip().lower()
    if not gl:
        return None
    for g in groups:  # exact label/name first
        if gl in (str(g.get("label", "")).lower(), str(g.get("name", "")).lower()):
            return g
    for g in groups:  # then substring
        if gl in str(g.get("label", "")).lower() or gl in str(g.get("name", "")).lower():
            return g
    return None


def query_group_stats(run_id: str, group_label: str, slice: str = "summary", *,
                      root: Path | str = history.DEFAULT_ROOT) -> dict:
    """One group's numbers: summary (avg_score, users, questions, critical) or critical
    (its critical questions). Clear note if there are no groups / the group isn't found."""
    result = history.load_run(run_id, root)
    if result is None:
        return {"error": f"Анализ {run_id} не найден."}
    groups = result.get("groups") or []
    if not groups:
        card = {"type": "stats", "title": "Группа", "metrics": [],
                "note": "Анализ без разбивки по группам."}
        return {"card": _echo_rid(card, run_id), "data": {}}
    g = _find_group(groups, group_label)
    if g is None:
        card = {"type": "stats", "title": "Группа", "metrics": [],
                "note": f"Группа «{group_label}» не найдена."}
        return {"card": _echo_rid(card, run_id), "data": {}}
    ans = g.get("answer") or {}
    gs = ans.get("summary") or {}
    crit_qs = [q for q in (ans.get("questions") or []) if q.get("critical")]
    label = g.get("label") or g.get("name") or group_label
    if slice == "critical":
        items = [{"text": q.get("question_text"), "value": _pct(q.get("correct_rate"))}
                 for q in crit_qs]
        card = {"type": "list", "title": f"Критические — {label}", "items": items}
        if not items:
            card["note"] = "В этой группе нет критических вопросов."
        return {"card": _echo_rid(card, run_id), "data": crit_qs}
    card = {"type": "stats", "title": f"Группа: {label}", "metrics": [
        {"label": "Средний балл", "value": f"{gs.get('avg_score')}%"},
        {"label": "Пользователи", "value": str(gs.get("total_users"))},
        {"label": "Вопросы", "value": str(gs.get("total_questions"))},
        {"label": "Критические", "value": str(len(crit_qs))},
    ]}
    return {"card": _echo_rid(card, run_id), "data": g}


def _score_key(s: dict) -> float:
    bs = s.get("best_score")
    return float(bs) if isinstance(bs, (int, float)) else -1.0


def query_students(run_id: str, filter: str = "weakest", limit: int = 10, *,
                   root: Path | str = history.DEFAULT_ROOT) -> dict:
    """Per-student rollup: weakest/strongest by best_score, or anomalies from
    attempt_anomalies. Clear note if the rollup is absent (old run)."""
    result = history.load_run(run_id, root)
    if result is None:
        return {"error": f"Анализ {run_id} не найден."}
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = 10
    if limit <= 0:
        limit = 10
    t = result.get("time") or {}

    if filter == "anomalies":
        anomalies = t.get("attempt_anomalies") or []
        items = [{"text": str(a.get("student_id")),
                  "value": f"попыток {a.get('attempts')}, "
                           f"балл {a.get('score_min')}–{a.get('score_max')}%"}
                 for a in anomalies[:limit]]
        card = {"type": "list", "title": "Аномалии попыток", "items": items}
        if not items:
            card["note"] = "Аномалий по попыткам не обнаружено."
        return {"card": _echo_rid(card, run_id), "data": anomalies[:limit]}

    students = t.get("students")
    if students is None:
        card = {"type": "list", "title": "Студенты", "items": [],
                "note": "Нет посписочных данных по студентам для этого прогона."}
        return {"card": _echo_rid(card, run_id), "data": []}
    ranked = sorted(students, key=_score_key, reverse=(filter == "strongest"))[:limit]
    items = []
    for s in ranked:
        bs = s.get("best_score")
        score_str = f"{bs}%" if isinstance(bs, (int, float)) else "н/д"
        status = _STUDENT_STATUS.get(s.get("status"), s.get("status") or "—")
        items.append({"text": str(s.get("student_id")),
                      "value": f"лучший балл {score_str}, попыток {s.get('attempts')}, {status}"})
    title = "Сильные студенты" if filter == "strongest" else "Слабые студенты"
    card = {"type": "list", "title": title, "items": items}
    if not items:
        card["note"] = "Список студентов пуст."
    return {"card": _echo_rid(card, run_id), "data": ranked}


def query_trends(run_ids: list[str], metric: str = "avg_score", *,
                 root: Path | str = history.DEFAULT_ROOT) -> dict:
    """Longitudinal series over ≥2 runs: avg_score or critical count per run, sorted by
    created_at when known (else input order). Note if fewer than two usable runs."""
    ids = [r for r in (run_ids or []) if r]
    if len(ids) < 2:
        return {"card": {"type": "list", "title": "Динамика", "items": [],
                         "note": "Для динамики нужно минимум два прогона (run_ids)."},
                "data": []}
    meta_by_id = {m.get("id"): m for m in history.list_runs(root)}
    series = []
    for rid in ids:
        result = history.load_run(rid, root)
        if result is None:
            continue
        ans = result.get("answer") or {}
        summary = ans.get("summary") or {}
        crit = sum(1 for q in (ans.get("questions") or []) if q.get("critical"))
        meta = meta_by_id.get(rid) or {}
        series.append({
            "run_id": rid,
            "name": meta.get("name") or result.get("course_id") or rid,
            "created_at": meta.get("created_at") or ans.get("analyzed_at") or "",
            "avg_score": summary.get("avg_score"),
            "critical": crit,
        })
    if len(series) < 2:
        return {"card": {"type": "list", "title": "Динамика", "items": [],
                         "note": "Недостаточно доступных прогонов для динамики (нужно ≥2)."},
                "data": series}
    if all(s["created_at"] for s in series):
        series = sorted(series, key=lambda s: s["created_at"])
    key = "critical" if metric == "critical" else "avg_score"
    metric_label = "критические" if metric == "critical" else "средний балл"
    items = []
    for s in series:
        val = s[key]
        val_str = str(val) if key == "critical" else f"{val}%"
        label = f"{s['name']} ({s['created_at']})" if s["created_at"] else s["name"]
        items.append({"text": label, "value": val_str})
    return {"card": {"type": "list", "title": f"Динамика: {metric_label}", "items": items},
            "data": series}


def _find_question_by(questions: list[dict], question_id: str, question_text: str) -> dict | None:
    qid = (question_id or "").strip()
    qt = (question_text or "").strip().lower()
    if qid:
        for q in questions:
            if str(q.get("question_id")) == qid:
                return q
    if qt:
        for q in questions:
            if qt in str(q.get("question_text", "")).lower():
                return q
    return None


def query_question_errors(run_id: str, question_id: str = "", question_text: str = "", *,
                          root: Path | str = history.DEFAULT_ROOT) -> dict:
    """One question's typical wrong answers (common_errors) with their counts, plus a note
    with доля верных and the ИИ-разборов count when present. Clear note if not found."""
    result = history.load_run(run_id, root)
    if result is None:
        return {"error": f"Анализ {run_id} не найден."}
    q = _find_question_by(_questions(result), question_id, question_text)
    if q is None:
        ref = question_id or question_text or ""
        card = {"type": "list", "title": "Ошибки по вопросу", "items": [],
                "note": f"Вопрос «{ref}» не найден в этом анализе."}
        return {"card": _echo_rid(card, run_id), "data": {}}
    errors = q.get("common_errors") or []
    items = [{"text": e.get("answer"), "value": f"×{e.get('count')}"} for e in errors]
    note_parts = [f"Доля верных: {_pct(q.get('correct_rate'))}"]
    reviews = q.get("llm_reviews") or []
    if reviews:
        note_parts.append(f"ИИ-разборов: {len(reviews)}")
    note = " · ".join(note_parts)
    if not items:
        note = "Типичных ошибок не зафиксировано. " + note
    card = {"type": "list", "title": q.get("question_text") or "Ошибки по вопросу",
            "items": items, "note": note}
    return {"card": _echo_rid(card, run_id), "data": q}


# --- P6 deliverable: a saved text report the methodologist can take away ---
# Wraps report_agent.generator.render_text — the SAME renderer the CLI and /analyze use —
# so chat produces the identical deliverable instead of leaving the user to copy scrollback.


def generate_report(run_id: str, sections: list[str] | None = None, format: str = "markdown", *,
                    root: Path | str = history.DEFAULT_ROOT) -> dict:
    """Render a run into the ready-to-send text report (deliverable для методиста/руководителя).

    Loads the stored run and feeds it to ``render_text`` (whole-result renderer). ``sections``
    is advisory: render_text builds the report целиком, so the requested sections are recorded
    as a best-effort footnote rather than trimming the deliverable. Returns a NEW «report» card
    ({type, title, markdown}) plus data={run_id, report}. Defensive: unknown run → «не найден»;
    empty/failed render → a clear Russian note instead of a crash."""
    result = history.load_run(run_id, root)
    if result is None:
        return {"error": f"Анализ {run_id} не найден."}
    try:
        text = render_text(result)
    except Exception:  # malformed/partial run — never crash the chat loop
        text = ""
    if not text or not text.strip():
        note = "Не удалось сформировать отчёт по этому прогону — нет данных для рендера."
        card = {"type": "report", "title": "Отчёт по анализу", "markdown": note, "note": note}
        return {"card": _echo_rid(card, run_id), "data": {"run_id": run_id, "report": ""}}
    requested = ", ".join(str(s) for s in (sections or []) if str(s).strip())
    if requested:
        # render_text не умеет выбирать разделы — отчёт приводим целиком, но честно фиксируем,
        # какие разделы были запрошены (best-effort).
        text = text.rstrip("\n") + f"\n\n(Запрошены разделы: {requested}. Отчёт приведён целиком.)\n"
    card = {"type": "report", "title": "Отчёт по анализу", "markdown": text}
    return {"card": _echo_rid(card, run_id), "data": {"run_id": run_id, "report": text}}


_SCHEMAS = {
    "list_runs": {"name": "list_runs", "description": "Список прошлых анализов (фильтры опциональны).",
                  "parameters": {"type": "object", "properties": {"filters": {"type": "object"}}}},
    "load_run": {"name": "load_run", "description": "Загрузить прошлый анализ по id и показать сводку.",
                 "parameters": {"type": "object", "properties": {"run_id": {"type": "string"}}, "required": ["run_id"]}},
    "query_stats": {"name": "query_stats", "description": "Цифры из анализа: срез summary|critical|attempts|question (для question — query).",
                    "parameters": {"type": "object", "properties": {"run_id": {"type": "string"},
                        "slice": {"type": "string"}, "query": {"type": "string"}}, "required": ["slice"]}},
    "compare_runs": {"name": "compare_runs", "description": "Сравнить два анализа по id.",
                     "parameters": {"type": "object", "properties": {"run_id_a": {"type": "string"},
                        "run_id_b": {"type": "string"}}, "required": ["run_id_a", "run_id_b"]}},
    "run_analysis": {"name": "run_analysis", "description": "Запустить анализ по приложенным в чат файлам (зарубежные модели; требует подтверждения). Можно настроить запуск целиком: глубину разбора (max_llm_calls), что анализировать (mode), какие ИИ-выводы сгенерировать (insight_blocks) и доп. указание для них (insight_note). Если имя файла-ЭТАЛОНА с правильными ответами НЕ содержит слово «эталон» — обязательно передайте reference_filename с точным именем этого файла, иначе свободные ответы могут быть сверены не с тем ключом.",
                     "parameters": {"type": "object", "properties": {"params": {
                         "type": "object",
                         "description": "Параметры анализа. Все поля опциональны — задавайте только то, что нужно настроить.",
                         "properties": {
                             "max_llm_calls": {"type": "integer",
                                 "description": "Бюджет вызовов ИИ для разбора свободных ответов: целое; 0 = код-только без ИИ-разбора свободных ответов (по умолчанию, бесплатно), >0 = глубокий разбор с ИИ."},
                             "mode": {"type": "string", "enum": ["answer", "time", "all"],
                                 "description": "Что анализировать: answer = только ответы, time = только время/попытки, all = всё."},
                             "insight_blocks": {"type": "array", "items": {"type": "string"},
                                 "description": "Какие ИИ-выводы сгенерировать: diagnosis / why_failed / recommendations / anomalies. Пусто или отсутствует = без ИИ-выводов."},
                             "insight_note": {"type": "string",
                                 "description": "Доп. указание (свободный текст) для ИИ-комментария: на чём сделать акцент, контекст курса и т.п."},
                             "course_id": {"type": "string",
                                 "description": "Метка (название) этого прогона для истории анализов."},
                             "reference_filename": {"type": "string",
                                 "description": "Точное имя загруженного файла-ЭТАЛОНА с правильными ответами. Передавайте, когда имя эталона не содержит слово «эталон», иначе свободные ответы будут сверены не с тем ключом."},
                         }}}}},
    "list_tests": {"name": "list_tests",
                   "description": "Список тестов в анализе: по каждому — число вопросов, критических и медиана балла.",
                   "parameters": {"type": "object", "properties": {"run_id": {"type": "string"}}}},
    "query_by_test": {"name": "query_by_test",
                      "description": "Срез по одному тесту: slice=critical (его критические вопросы) или summary (средняя доля верных, вопросов, критических).",
                      "parameters": {"type": "object", "properties": {"run_id": {"type": "string"},
                          "test_name": {"type": "string"}, "slice": {"type": "string"}}, "required": ["test_name"]}},
    "list_groups": {"name": "list_groups",
                    "description": "Список групп (файлов) внутри анализа: пользователей, средний балл, критических. Если разбивки нет — сообщает об этом.",
                    "parameters": {"type": "object", "properties": {"run_id": {"type": "string"}}}},
    "query_group_stats": {"name": "query_group_stats",
                          "description": "Цифры по одной группе: slice=summary (средний балл, пользователи, вопросы, критические) или critical (её критические вопросы).",
                          "parameters": {"type": "object", "properties": {"run_id": {"type": "string"},
                              "group_label": {"type": "string"}, "slice": {"type": "string"}}, "required": ["group_label"]}},
    "query_students": {"name": "query_students",
                       "description": "Посписочные данные по студентам: filter=weakest|strongest (по лучшему баллу) или anomalies (аномалии попыток); limit — сколько показать.",
                       "parameters": {"type": "object", "properties": {"run_id": {"type": "string"},
                           "filter": {"type": "string"}, "limit": {"type": "integer"}}}},
    "query_trends": {"name": "query_trends",
                     "description": "Динамика по нескольким прогонам: metric=avg_score|critical. Нужно ≥2 run_ids.",
                     "parameters": {"type": "object", "properties": {
                         "run_ids": {"type": "array", "items": {"type": "string"}},
                         "metric": {"type": "string"}}, "required": ["run_ids"]}},
    "query_question_errors": {"name": "query_question_errors",
                              "description": "Типичные ошибки по вопросу (по question_id или фрагменту текста) и доля верных.",
                              "parameters": {"type": "object", "properties": {"run_id": {"type": "string"},
                                  "question_id": {"type": "string"}, "question_text": {"type": "string"}}}},
    "generate_report": {"name": "generate_report",
                        "description": "Сформировать готовый текстовый отчёт по анализу (для отправки методисту/руководителю).",
                        "parameters": {"type": "object", "properties": {"run_id": {"type": "string"},
                            "sections": {"type": "array", "items": {"type": "string"},
                                         "description": "Опционально: какие разделы интересуют (summary, critical, recommendations …)."},
                            "format": {"type": "string",
                                       "description": "Формат отчёта; по умолчанию markdown (готовый текст)."}}}},
}


def build_registry(*, root: Path | str = history.DEFAULT_ROOT,
                   active_run_id: str | None = None, rerun=None, uploads=None) -> dict:
    """name -> {"schema", "fn"}. fn takes a single ``arguments`` dict; run_id defaults
    to the active context when omitted. ``uploads`` are the chat's staged files that
    run_analysis analyses."""
    def _rid(args: dict) -> str:
        return args.get("run_id") or active_run_id or ""

    fns = {
        "list_runs": lambda a: list_runs(a.get("filters"), root=root),
        "load_run": lambda a: load_run(_rid(a), root=root),
        "query_stats": lambda a: query_stats(_rid(a), a.get("slice", ""), query=a.get("query", ""), root=root),
        "compare_runs": lambda a: compare_runs(a.get("run_id_a", ""), a.get("run_id_b", ""), root=root),
        "run_analysis": lambda a: run_analysis(a.get("params", {}), rerun=rerun, uploads=uploads),
        "list_tests": lambda a: list_tests(_rid(a), root=root),
        "query_by_test": lambda a: query_by_test(_rid(a), a.get("test_name", ""),
                                                  slice=a.get("slice", "critical"), root=root),
        "list_groups": lambda a: list_groups(_rid(a), root=root),
        "query_group_stats": lambda a: query_group_stats(_rid(a), a.get("group_label", ""),
                                                          slice=a.get("slice", "summary"), root=root),
        "query_students": lambda a: query_students(_rid(a), filter=a.get("filter", "weakest"),
                                                   limit=a.get("limit", 10), root=root),
        "query_trends": lambda a: query_trends(a.get("run_ids") or [],
                                               metric=a.get("metric", "avg_score"), root=root),
        "query_question_errors": lambda a: query_question_errors(_rid(a),
                                                                 question_id=a.get("question_id", ""),
                                                                 question_text=a.get("question_text", ""), root=root),
        "generate_report": lambda a: generate_report(_rid(a), sections=a.get("sections"),
                                                      format=a.get("format", "markdown"), root=root),
    }
    return {name: {"schema": _SCHEMAS[name], "fn": fns[name]} for name in _SCHEMAS}
