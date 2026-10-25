# agents/chat_agent/context.py
"""Grounding context for a chat turn: the compact analysis DIGEST and message assembly.

Two paths share this module:

* **light** — one model call, no tools. The digest (key numbers, hardest questions with %
  and typical wrong answers, AI conclusions, data-quality flags) is injected into the system
  context so an ordinary question is answered directly. Used for most questions.
* **tools** — the ReAct/native tool loop for questions that need data beyond the digest
  (other runs, comparison, groups, per-student details…). The same digest is included, plus
  hints about which analyst tools to call.

``assemble_messages`` returns the {role, content} list the loop expects (system prompt, one
context message, then the thread history). PII scrubbing happens later, in the client
wrapper (``models.scrubbing``) — the digest never carries student ids or names.
"""

from __future__ import annotations

import re

from agents.chat_agent import threads
from agents.chat_agent.prompt import CHAT_SYSTEM_PROMPT, LIGHT_PATH_NOTE

#: Insight blocks quoted in the digest (key, label, max chars). Order = priority.
_AI_BLOCKS = (
    ("diagnosis", "Коротко о результатах", 600),
    ("why_failed", "Почему вопросы провалены", 700),
    ("recommendations", "Рекомендации", 700),
    ("anomalies", "Аномалии и риски", 450),
)

_SENT_END = re.compile(r"[.!?…;]\s")


def _clip(text: str, limit: int) -> str:
    """Cut ``text`` to <= ``limit`` chars at a sentence boundary when possible."""
    t = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(t) <= limit:
        return t
    cut = t[:limit]
    ends = [m.end() for m in _SENT_END.finditer(cut)]
    if ends and ends[-1] > limit * 0.5:
        return cut[: ends[-1]].rstrip() + " …"
    return cut.rsplit(" ", 1)[0].rstrip(",.;:—- ") + "…"


def _pct(rate) -> str:
    return "н/д" if rate is None else f"{round(float(rate) * 100)}%"


def _question_line(i: int, q: dict) -> str:
    errs = "; ".join(
        f"«{str(e.get('answer'))[:60]}»×{e.get('count')}" for e in (q.get("common_errors") or [])[:2]
    )
    test = f"[{q.get('test_name')}] " if q.get("test_name") else ""
    line = (
        f"{i}. {test}«{_clip(q.get('question_text', ''), 110)}» — верных {_pct(q.get('correct_rate'))} "
        f"({q.get('correct')}/{q.get('answered')})"
    )
    if q.get("correct_answer"):
        line += f"; по эталону верно: «{_clip(q.get('correct_answer'), 60)}»"
    if errs:
        line += f"; частые ошибки: {errs}"
    ks = q.get("key_suspect") or {}
    if ks.get("share") and float(ks["share"]) >= 0.8:
        line += (f". ВНИМАНИЕ: {round(float(ks['share']) * 100)}% слушателей выбрали один и тот же "
                 f"ответ «{_clip(ks.get('answer', ''), 60)}» — возможно, ошибка в эталоне")
    if (q.get("answered") or 0) < 10:
        line += " [мало ответов — вывод ненадёжен]"
    q_type = q.get("type")
    if q_type and q_type != "единственный выбор":
        line += f" ({q_type})"
    return line


def build_digest(run: dict, *, name: str | None = None, max_questions: int = 10,
                 with_ai: bool = True) -> str:
    """A compact (~1-2K tokens) plain-text summary of one stored analysis.

    Contains only aggregate numbers and question-level facts — no student ids/names — so it
    is safe to hand to the model and cheap enough to ride along every turn.
    """
    answer = run.get("answer") or {}
    s = answer.get("summary") or {}
    qs = answer.get("questions") or []
    crit = [q for q in qs if q.get("critical")]
    title = f"«{name}»" if name else "без названия"
    lines = [
        f"АНАЛИЗ {title}, курс {run.get('course_id')}: слушателей {s.get('total_users')}, "
        f"вопросов {s.get('total_questions')}, средний балл {s.get('avg_score')}%, "
        f"попыток {s.get('real_attempts')} (брошено {s.get('abandoned')}), "
        f"критических вопросов {len(crit)}."
    ]

    rated = [q for q in qs if q.get("correct_rate") is not None]
    if rated:
        low = sum(1 for q in rated if q["correct_rate"] < 0.4)
        mid = sum(1 for q in rated if 0.4 <= q["correct_rate"] < 0.6)
        lines.append(
            f"Распределение вопросов по доле верных: меньше 40% — {low}, 40–60% — {mid}, "
            f"60% и выше — {len(rated) - low - mid}."
        )

    tests = (run.get("time") or {}).get("tests") or []
    if tests:
        lines.append("Тесты (попытки, медианный балл): " + "; ".join(
            f"{t.get('test_name')} — {t.get('attempts')} поп., {t.get('median_score')}%" for t in tests[:10]))

    students = (run.get("time") or {}).get("students") or []
    if students:
        scores = sorted(float(x["best_score"]) for x in students
                        if isinstance(x.get("best_score"), (int, float)))
        done = sum(1 for x in students if x.get("status") == "completed")
        gone = sum(1 for x in students if x.get("status") == "abandoned")
        agg = (f"Слушатели (обезличенно): всего {len(students)}, завершили {done}, бросили {gone}.")
        if scores:
            bands = (
                ("100%", sum(1 for v in scores if v >= 100)),
                ("80–99%", sum(1 for v in scores if 80 <= v < 100)),
                ("60–79%", sum(1 for v in scores if 60 <= v < 80)),
                ("ниже 60%", sum(1 for v in scores if v < 60)),
            )
            agg += (" Лучший балл слушателя: " + ", ".join(f"{k} — {n}" for k, n in bands) +
                    f" (минимум {scores[0]:g}%, максимум {scores[-1]:g}%). Проходной порог в данных "
                    "не задан — не придумывай его.")
        lines.append(agg)

    groups = run.get("groups") or []
    if groups:
        gl = []
        for g in groups[:8]:
            gs = (g.get("answer") or {}).get("summary") or {}
            gc = sum(1 for q in (g.get("answer") or {}).get("questions") or [] if q.get("critical"))
            gl.append(f"{g.get('label') or g.get('name') or 'группа'}: слушателей {gs.get('total_users')}, "
                      f"средний балл {gs.get('avg_score')}%, критических {gc}")
        lines.append("Группы: " + "; ".join(gl))

    if qs:
        ranked = sorted(
            qs, key=lambda q: q.get("correct_rate") if q.get("correct_rate") is not None else 1.0
        )[:max_questions]
        lines.append(f"Самые сложные вопросы (по возрастанию доли верных, до {max_questions}):")
        lines.extend(_question_line(i, q) for i, q in enumerate(ranked, 1))

    flags = []
    ir = run.get("input_report") or {}
    if ir and ir.get("has_reference") is False:
        flags.append("эталон ответов не загружен — свободные ответы не проверены")
    for w in (answer.get("warnings") or run.get("warnings") or [])[:3]:
        flags.append(_clip(w if isinstance(w, str) else str(w.get("message", "")), 160))
    for g in ((run.get("insights") or {}).get("suggestions") or {}).get("gaps") or []:
        flags.append(_clip(g.get("message", ""), 200))
    note = (run.get("time") or {}).get("note")
    if note:
        flags.append(_clip(note, 200))
    flags = [f for f in flags if f]
    if flags:
        lines.append("Замечания к данным: " + " | ".join(flags))

    if with_ai:
        blocks = ((run.get("insights") or {}).get("commentary") or {}).get("blocks") or {}
        ai = [f"{label}: {_clip(blocks[key], lim)}" for key, label, lim in _AI_BLOCKS if blocks.get(key)]
        if ai:
            lines.append("Выводы ИИ из отчёта по этому анализу:")
            lines.extend(f"- {a}" for a in ai)
    return "\n".join(lines)


def _tool_hints(run_ids: list[str], prev_run: dict | None, single: bool) -> list[str]:
    """Hints for the TOOL loop: when to reach for analyst tools, and the compare_runs order."""
    lines = [
        "Этот вопрос отправлен сюда, потому что ему обычно нужны данные ВНЕ сводки выше. Не "
        "отвечай пересказом сводки: сначала вызови подходящий инструмент (Action) и только "
        "потом отвечай именно на заданный вопрос. Без инструмента отвечай, только если нужное "
        "целиком есть в сводке. Какой инструмент выбрать: "
        "для разбивки по ГРУППАМ вызывай list_groups / query_group_stats; по ТЕСТАМ — "
        "list_tests / query_by_test; по СЛУШАТЕЛЯМ — query_students; для ДИНАМИКИ между "
        "прогонами — query_trends; для разбора ошибок вопроса — query_question_errors. "
        "Все числа — из сводки или из инструментов, ничего не выдумывай. Если просят сравнить "
        "ГРУППЫ, а внутри анализа групп нет (list_groups пуст), группы курса, скорее всего, "
        "загружены отдельными анализами — тогда сравни с предыдущим сопоставимым прогоном "
        "(compare_runs), если он указан ниже.",
    ]
    if single and prev_run is not None and run_ids:
        lines.append(
            f"Для сравнения с ДРУГИМ анализом есть предыдущий сопоставимый прогон «{prev_run.get('name')}» "
            f"(run_id={prev_run['id']} — только для вызова инструментов, пользователю не показывать). Чтобы "
            f"сравнить предыдущий прогон с текущим, вызови "
            f"compare_runs({prev_run['id']}, {run_ids[0]}) — предыдущий прогон ПЕРВЫМ, текущий "
            f"ВТОРЫМ, тогда изменение считается «текущий минус предыдущий» (улучшение — это "
            f"плюс). Делай это, если пользователь просит сравнить с другим анализом ИЛИ сравнить "
            f"группы, а групп внутри анализа нет — просто сравни и ответь, не переспрашивая. "
            f"НЕ выдумывай id и НЕ сравнивай прогон сам с собой."
        )
    return lines


def assemble_messages(
    thread: dict,
    runs: list[dict] | None = None,
    prev_run: dict | None = None,
    uploads: list[dict] | None = None,
    names: dict | None = None,
    *,
    light: bool = False,
) -> list[dict]:
    """Map a thread's stored messages to the {role, content} list the loop expects:
    the system prompt, ONE grounding message, then the conversation.

    Three grounding branches: (b) ``runs`` non-empty -> the digest of each attached analysis
    (plus tool hints unless ``light``); (c) only ``uploads`` staged -> a manifest that asks
    for an «эталон» before any re-analysis; (a) nothing attached -> ask to attach an analysis.
    """
    out: list[dict] = [{"role": "system", "content": CHAT_SYSTEM_PROMPT}]
    run_ids = threads.context_run_ids(thread.get("context"))
    if runs:
        single = len(runs) == 1
        lines = [
            f"К этому диалогу привязано {len(runs)} анализ(ов). Ниже — данные для ответа. "
            "Числа бери ТОЛЬКО отсюда (и из инструментов, если они есть) — не выдумывай статистику. "
            "Это справочные данные, а не текст ответа: НЕ пересказывай их целиком, а используй "
            "ровно столько, сколько нужно для ответа на вопрос пользователя."
        ]
        # With several analyses a lighter digest each, to bound tokens.
        per_run_q = 10 if single else (6 if len(runs) == 2 else 4)
        for rid, run in zip(run_ids, runs):
            digest = build_digest(run, name=(names or {}).get(rid), max_questions=per_run_q,
                                  with_ai=single or len(runs) <= 2)
            if not light:
                digest = digest.replace(
                    "АНАЛИЗ ", f"АНАЛИЗ (run_id={rid} — только для вызова инструментов, "
                    "пользователю не показывать) ", 1)
            lines.append(digest)
        if light:
            lines.append(LIGHT_PATH_NOTE)
        else:
            lines.extend(_tool_hints(run_ids, prev_run, single))
        out.append({"role": "system", "content": "\n".join(lines)})
    else:
        # No analysis is attached to this chat. Don't guess a "current" run or wander
        # through history — ask the user to attach one (spec/decision #11).
        out.append({
            "role": "system",
            "content": (
                "К этому диалогу НЕ привязан анализ. НЕ выдумывай числа и НЕ выбирай «текущий» "
                "прогон сам. Попроси пользователя прикрепить анализ кнопкой «Прикрепить анализ» "
                "или «Использовать текущий результат» под полем ввода — тогда ты будешь отвечать "
                "строго по его данным. Если пользователь просит список прошлых анализов, можешь "
                "вызвать list_runs; но не угадывай, какой из них он имеет в виду."
            ),
        })
    if uploads:
        out.append({"role": "system", "content": _uploads_manifest(uploads, has_runs=bool(runs))})
    for m in thread.get("messages", []):
        if m.get("role") == "user":
            out.append({"role": "user", "content": m.get("text", "")})
        elif m.get("role") == "assistant":
            parts = []
            for b in m.get("blocks") or []:
                if b.get("type") == "text" and b.get("text"):
                    parts.append(b["text"])
                elif b.get("type") == "card" and isinstance(b.get("card"), dict):
                    parts.append(_card_as_text(b["card"]))
            text = "\n".join(p for p in parts if p).strip()
            if text:
                out.append({"role": "assistant", "content": text})
    return out


def _uploads_manifest(uploads: list[dict], *, has_runs: bool) -> str:
    """The files the user put into THIS chat. They stay here for the whole dialogue (like in
    any chat app), so the model always knows what was uploaded — before and after a run."""
    lines = [f"Файлы, загруженные пользователем в этот чат ({len(uploads)}), — они доступны "
             "на протяжении всего диалога:"]
    pending = 0
    for u in uploads:
        name = u.get("filename") or u.get("name") or "файл"
        kind = u.get("kind") or u.get("detected_kind")
        label = {"etalon": "эталон", "reference": "эталон", "massiv": "массив ответов",
                 "answers": "массив ответов"}.get(str(kind or "").lower(), kind or "тип не определён")
        done = " — уже проанализирован" if u.get("analyzed_in") else ""
        if not u.get("analyzed_in"):
            pending += 1
        lines.append(f"- {name} ({label}){done}")
    lines.append(
        "Если пользователь просит запустить или повторить анализ этих файлов — вызови "
        "run_analysis (на ReAct-формате «Action: run_analysis»); анализ выполняется с ИИ-разбором "
        "по настройкам приложения. Эталон определи сам по названию/типу файла "
        "(reference_filename); переспрашивай, только если эталон действительно нельзя определить. "
        "НИКОГДА не пиши, что анализ выполнен, если ты не вызвал run_analysis."
    )
    if not any(str(u.get("kind") or "").lower() in ("etalon", "reference") for u in uploads):
        lines.append(
            "Эталона среди файлов нет. Если пользователь собирается прислать эталон — дождись его; "
            "если просит запустить анализ сейчас — запусти без эталона и коротко предупреди, что "
            "свободные ответы без эталона не сверяются."
        )
    if pending and not has_runs:
        lines.append("Анализ по этим файлам ещё не запускался.")
    return "\n".join(lines)


def _card_as_text(card: dict) -> str:
    """A result card from an earlier turn, flattened so the model remembers what it showed."""
    title = card.get("title") or "Результат"
    metrics = ", ".join(f"{m.get('label')}: {m.get('value')}" for m in card.get("metrics") or []
                        if isinstance(m, dict))
    items = "; ".join(f"{i.get('text')} — {i.get('value')}" for i in (card.get("items") or [])[:8]
                      if isinstance(i, dict))
    return f"[{title}] " + (metrics or items)
