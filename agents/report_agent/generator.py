"""Report generation for Agent 3: machine-readable JSON + plain-text Russian summary.

Excel (colour-coded) + visualizations land in a later phase; Phase 1 produces the two
formats a methodologist needs to read results immediately.
"""

from __future__ import annotations

import json
import textwrap
from pathlib import Path

from agents.insight_agent._common import text_of


def write_reports(result: dict, out_dir: str | Path, *, course_id: str) -> list[Path]:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    json_path = out / f"report_{course_id}.json"
    json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    txt_path = out / f"report_{course_id}.txt"
    txt_path.write_text(render_text(result), encoding="utf-8")
    return [json_path, txt_path]


def _plural(n: int, one: str, few: str, many: str) -> str:
    n = abs(int(n))
    if n % 100 in (11, 12, 13, 14):
        return many
    return one if n % 10 == 1 else few if n % 10 in (2, 3, 4) else many


def _wrap(text: str, indent: str = "", width: int = 100) -> list[str]:
    """Wrap on word boundaries (never cut a sentence mid-word); keep explicit line breaks."""
    out: list[str] = []
    for para in str(text).splitlines() or [""]:
        out.extend(
            textwrap.wrap(para, width=width, initial_indent=indent, subsequent_indent=indent + "  ")
            or [indent.rstrip()]
        )
    return out


def _want(sections, *keys: str) -> bool:
    """True when ``sections`` is None (everything) or shares an id with ``keys``."""
    return sections is None or bool(set(keys) & set(sections))


def render_text(result: dict, name: str | None = None, sections=None) -> str:
    """Plain-text report. ``sections`` (ids from the export screen: metrics / questions /
    critical / ai / anomalies) limits what is written; None = everything."""
    lines: list[str] = []
    cid = result.get("course_id")
    if name:
        lines.append(f"ОТЧЁТ: {name}")
    elif cid and str(cid).lower() != "анализ":
        lines.append(f"ОТЧЁТ ПО КУРСУ {cid}")
    else:
        lines.append("ОТЧЁТ ПО АНАЛИЗУ")
    lines.append("=" * 60)

    rep = result.get("input_report") or {}
    skipped = rep.get("skipped") or []
    if rep.get("groups_total"):
        lines.append(f"Учтено групп: {rep.get('groups_used')} из {rep.get('groups_total')}")
    for d in skipped:
        reason = str(d.get("reason") or "")
        lines.append(
            "ВНИМАНИЕ: " + (reason if f"«{d.get('file')}»" in reason
                            else f"файл «{d.get('file')}» не учтён — {reason}")
        )
    for lim in rep.get("limitations") or []:
        lines.append(f"Ограничение: {lim}")
    if rep.get("groups_total") or skipped or rep.get("limitations"):
        lines.append("")

    a1 = result.get("answer") or {}
    if a1 and _want(sections, "metrics", "summary"):
        s = a1.get("summary", {})
        lines.append(
            f"Слушателей: {s.get('total_users')}   Вопросов: {s.get('total_questions')}   "
            f"Средний балл: {s.get('avg_score')}%"
        )
        lines.append(
            f"Реальных попыток: {s.get('real_attempts')}   Брошенных: {s.get('abandoned')}"
        )
    if a1 and _want(sections, "critical", "questions"):
        crit = [q for q in a1.get("questions", []) if q.get("critical")]
        lines.append("")
        lines.append(
            f"Критических вопросов (доля верных ниже порога): {len(crit)}"
        )
        for q in sorted(crit, key=lambda x: x["correct_rate"])[:10]:
            lines.extend(_wrap(f"[{q['correct_rate'] * 100:.0f}% верных] {q['question_text']}", "  "))
            if q.get("correct_answer"):
                lines.extend(_wrap(f"✓ верный ответ: {q['correct_answer']}", "        "))
            for e in q.get("common_errors", [])[:3]:
                lines.extend(_wrap(f"✗ {e['answer']} (×{e['count']})", "        "))
            ks = q.get("key_suspect")
            if ks:
                lines.append(
                    f"        ! Возможна ошибка в эталоне: самый частый «неверный» ответ выбрали "
                    f"{round(ks.get('share', 0) * 100)}% отвечавших"
                )
        u = a1.get("llm_usage", {})
        if u.get("calls"):
            fn = sum(q.get("llm_false_negatives", 0) for q in a1.get("questions", []))
            lines.append("")
            lines.append(
                f"LLM-проверок: {u['calls']}   токены вх/вых: {u['prompt_tokens']}/{u['completion_tokens']}"
                f"   стоимость: ${u['cost']}"
            )
            lines.append(f"Возможно зачтены по смыслу (ошибочно помечены неверными): {fn}")
        auto_fn = sum(q.get("auto_false_negatives", 0) for q in a1.get("questions", []))
        if auto_fn:
            lines.append("")
            lines.append(
                f"Зачтены автоматически (совпадение с эталоном): {auto_fn}"
            )
        if a1.get("warnings"):
            lines.append("")
            n = len(a1["warnings"])
            lines.append(f"Предупреждения при чтении файлов: {n}")
            for w in a1["warnings"][:10]:
                lines.extend(_wrap(f"• {w}", "  "))

    ins = (result.get("insights") or {}) if _want(sections, "ai") else {}
    commentary = ins.get("commentary") or {}
    suggestions = ins.get("suggestions") or {}
    if commentary.get("blocks") or commentary.get("custom"):
        lines.append("")
        lines.append("ИИ-ВЫВОДЫ")
        lines.append("-" * 60)
        titles = {
            "diagnosis": "Коротко о результатах", "why_failed": "Почему вопросы провалены",
            "recommendations": "Рекомендации", "anomalies": "Аномалии и риски",
        }
        for key, txt in commentary.get("blocks", {}).items():
            lines.append(f"  {titles.get(key, key)}:")
            lines.extend(_wrap(text_of(txt), "    "))
        if commentary.get("custom"):
            lines.append("  По запросу:")
            lines.extend(_wrap(text_of(commentary["custom"]), "    "))
    if suggestions.get("gaps") or suggestions.get("narrative"):
        lines.append("")
        lines.append("РЕКОМЕНДАЦИИ ПО ДАННЫМ")
        lines.append("-" * 60)
        if suggestions.get("narrative"):
            lines.extend(_wrap(text_of(suggestions["narrative"]), "  "))
        for g in suggestions.get("gaps", []):
            lines.extend(_wrap(f"• {g['message']}", "  "))

    a2 = (result.get("time") or {}) if _want(sections, "anomalies", "time") else {}
    if a2:
        lines.append("")
        lines.append("АНАЛИЗ ПОПЫТОК")
        lines.append("-" * 60)
        lines.extend(_wrap(str(a2.get("note")), "  "))
        lines.append(f"  Доля брошенных попыток: {a2.get('abandoned_rate')}%")
        anomalies = a2.get("attempt_anomalies", [])
        if anomalies:
            lines.append(
                f"  Слушателей с необычным ходом попыток: {len(anomalies)} "
                f"(скачок балла после брошенной/почти нулевой попытки или большой разброс "
                f"баллов при нескольких попытках)"
            )
            for an in anomalies[:5]:
                lines.append(
                    f"    слушатель {an['student_id']}: попыток {an['attempts']}, "
                    f"балл {an['score_min']}→{an['score_max']}%"
                )

    return "\n".join(lines) + "\n"
