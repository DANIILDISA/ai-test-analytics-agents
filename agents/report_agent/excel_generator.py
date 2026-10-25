"""Excel report with conditional highlighting (Agent 3, КОРПУС C2 deliverable).

Builds an ``openpyxl`` workbook from a pipeline ``result`` and returns it as bytes
(ready to stream from the web layer or write to disk). Colour legend — applied as
solid cell fills so a methodologist sees the problem cells at a glance:

* RED    — критический вопрос / доля верных ниже порога;
* GREEN  — здоровый вопрос (доля верных в норме);
* BLUE   — слишком быстрая попытка («быстро» / too-fast аномалия);
* ORANGE — слишком медленная попытка («медленно» / too-slow аномалия).

The anomalies sheet states the engine's time-data limitation in its first row (from
``result["time"]["note"]``): the current LMS export carries no per-question durations,
so on real data the sheet lists attempt-pattern anomalies (by attempts/score spread);
the BLUE/ORANGE time fills apply only when a reason reports fast/slow timing.

Design rules honoured: nothing hardcoded that belongs in the data (numbers come
straight from ``result``), and the builder is defensive — a missing section, key,
or malformed row is skipped, never raised. ``sections`` filters which sheets are
emitted (default = all); the workbook always keeps at least one sheet so it stays
openable.
"""

from __future__ import annotations

from io import BytesIO
from typing import Iterable

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.worksheet import Worksheet

# Доля верных ниже этого порога считается провальной (см. config thresholds.critical_rate=0.5).
CRITICAL_RATE = 0.5

RED = PatternFill(start_color="FFC7CE", end_color="FFC7CE", fill_type="solid")
GREEN = PatternFill(start_color="C6EFCE", end_color="C6EFCE", fill_type="solid")
BLUE = PatternFill(start_color="BDD7EE", end_color="BDD7EE", fill_type="solid")
ORANGE = PatternFill(start_color="FFD966", end_color="FFD966", fill_type="solid")

_BOLD = Font(bold=True)
_WRAP = Alignment(vertical="top", wrap_text=True)

# Each sheet is emitted when ``sections`` is None or shares an alias with the request.
_SUMMARY_KEYS = {"summary", "metrics", "сводка"}
_QUESTIONS_KEYS = {"questions", "critical", "вопросы"}
_ANOMALIES_KEYS = {"anomalies", "time", "аномалии"}
_STUDENTS_KEYS = {"students", "студенты", "слушатели"}


def build_excel(result: dict, sections: Iterable[str] | str | None = None) -> bytes:
    """Render ``result`` to an .xlsx workbook (bytes). ``sections`` filters the sheets."""
    result = result or {}
    wanted = _norm_sections(sections)
    answer = result.get("answer") or {}
    time = result.get("time") or {}

    wb = Workbook()
    wb.remove(wb.active)  # drop the default sheet; we add only the ones we want

    if _wanted(_SUMMARY_KEYS, wanted):
        _summary_sheet(wb, answer, time, result)
    if _wanted(_QUESTIONS_KEYS, wanted):
        _questions_sheet(wb, answer)
    if _wanted(_ANOMALIES_KEYS, wanted):
        _anomalies_sheet(wb, time)
    if _wanted(_STUDENTS_KEYS, wanted) and time.get("students"):
        _students_sheet(wb, time)

    if not wb.sheetnames:  # never hand back a sheet-less workbook (openpyxl can't save it)
        ws = wb.create_sheet("Сводка")
        ws["A1"] = "Нет данных для выгрузки"

    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


# --------------------------------------------------------------------------- sheets


def _summary_sheet(wb: Workbook, answer: dict, time: dict, result: dict | None = None) -> None:
    ws = wb.create_sheet("Сводка")
    _header_row(ws, ["Показатель", "Значение"])

    s = answer.get("summary") or {}
    crit = sum(1 for q in (answer.get("questions") or []) if q.get("critical"))
    rows = [
        ("Пользователей", s.get("total_users")),
        ("Вопросов", s.get("total_questions")),
        ("Средний балл, %", s.get("avg_score")),
        ("Реальных попыток", s.get("real_attempts")),
        ("Брошенных попыток", s.get("abandoned")),
        ("Критических вопросов", crit),
        ("Доля брошенных попыток, %", time.get("abandoned_rate")),
    ]
    rep = (result or {}).get("input_report") or {}
    for d in rep.get("skipped") or []:
        rows.append(("Файл не учтён", f"{d.get('file')} — {d.get('reason')}"))
    for lim in rep.get("limitations") or []:
        rows.append(("Ограничение", lim))
    for label, value in rows:
        ws.append([label, _clean(value)])

    _widths(ws, {"A": 30, "B": 16})


def _questions_sheet(wb: Workbook, answer: dict) -> None:
    ws = wb.create_sheet("Вопросы")
    headers = ["Тест", "Вопрос", "Доля верных", "Ответили", "Критический", "Частые ошибки",
               "Правильный ответ", "Возможна ошибка в эталоне"]
    _header_row(ws, headers)

    for q in answer.get("questions") or []:
        if not isinstance(q, dict):
            continue
        rate = q.get("correct_rate")
        is_numeric_rate = isinstance(rate, (int, float)) and not isinstance(rate, bool)
        critical = bool(q.get("critical")) or (is_numeric_rate and rate < CRITICAL_RATE)

        ws.append([
            _clean(q.get("test_name")),
            _clean(q.get("question_text")),
            rate if is_numeric_rate else "",
            _clean(q.get("answered")),
            "да" if critical else "нет",
            _common_errors(q.get("common_errors")),
            _clean(q.get("correct_answer")),
            _key_suspect(q.get("key_suspect")),
        ])
        row = ws.max_row
        rate_cell = ws.cell(row=row, column=3)
        if is_numeric_rate:
            rate_cell.number_format = "0.0%"
            rate_cell.fill = RED if critical else GREEN
            # mirror the verdict on the «Критический» cell so the row reads at a glance
            ws.cell(row=row, column=5).fill = RED if critical else GREEN
        ws.cell(row=row, column=2).alignment = _WRAP
        ws.cell(row=row, column=6).alignment = _WRAP
        ws.cell(row=row, column=7).alignment = _WRAP
        ws.cell(row=row, column=8).alignment = _WRAP

    _widths(ws, {"A": 22, "B": 60, "C": 13, "D": 10, "E": 13, "F": 55, "G": 40, "H": 34})


def _anomalies_sheet(wb: Workbook, time: dict) -> None:
    ws = wb.create_sheet("Аномалии времени и попыток")
    headers = ["Слушатель", "Попыток", "Балл мин", "Балл макс", "Причина"]

    # Be honest in the file itself: the LMS export has no per-question time, so these are
    # attempt-pattern anomalies. time_agent states that in `note`; surface it as row 1.
    note = str(time.get("note") or "").strip()
    if note:
        ws.append([note])
        ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(headers))
        cell = ws.cell(row=1, column=1)
        cell.alignment = _WRAP
        cell.font = Font(italic=True)

    header_row = ws.max_row + 1 if note else 1
    ws.append(headers)
    for col in range(1, len(headers) + 1):
        ws.cell(row=header_row, column=col).font = _BOLD

    for an in time.get("attempt_anomalies") or []:
        if not isinstance(an, dict):
            continue
        reason = str(an.get("reason") or "")
        ws.append([
            _clean(an.get("student_id")),
            _clean(an.get("attempts")),
            _clean(an.get("score_min")),
            _clean(an.get("score_max")),
            reason,
        ])
        row = ws.max_row
        fill = _anomaly_fill(reason)
        if fill is not None:
            ws.cell(row=row, column=5).fill = fill
        ws.cell(row=row, column=5).alignment = _WRAP

    _widths(ws, {"A": 26, "B": 10, "C": 11, "D": 11, "E": 70})


def _students_sheet(wb: Workbook, time: dict) -> None:
    ws = wb.create_sheet("Слушатели")
    _header_row(ws, ["Слушатель", "Лучший балл", "Попыток", "Статус"])

    for st in time.get("students") or []:
        if not isinstance(st, dict):
            continue
        ws.append([
            _clean(st.get("student_id")),
            _clean(st.get("best_score")),
            _clean(st.get("attempts")),
            _clean(st.get("status")),
        ])

    _widths(ws, {"A": 26, "B": 13, "C": 10, "D": 16})


# --------------------------------------------------------------------------- helpers


def _anomaly_fill(reason: str) -> PatternFill | None:
    """BLUE for too-fast («быстро»), ORANGE for too-slow («медленно»); else no fill."""
    low = reason.lower()
    if "быстро" in low or "fast" in low:
        return BLUE
    if "медленно" in low or "slow" in low:
        return ORANGE
    return None


def _key_suspect(ks) -> str:
    if not isinstance(ks, dict):
        return ""
    share = ks.get("share")
    pct = f"{round(share * 100)}%" if isinstance(share, (int, float)) else ""
    return f"да: самый частый «неверный» ответ выбрали {pct}".strip()


def _common_errors(errors) -> str:
    if not isinstance(errors, (list, tuple)):
        return ""
    parts: list[str] = []
    for e in errors[:3]:
        if isinstance(e, dict):
            ans = str(e.get("answer", "")).strip()
            cnt = e.get("count")
            parts.append(f"{ans} (×{cnt})" if cnt is not None else ans)
        else:
            parts.append(str(e))
    return "; ".join(p for p in parts if p)


def _header_row(ws: Worksheet, labels: list[str]) -> None:
    ws.append(labels)
    for col in range(1, len(labels) + 1):
        ws.cell(row=1, column=col).font = _BOLD


def _widths(ws: Worksheet, widths: dict[str, int]) -> None:
    for col, w in widths.items():
        ws.column_dimensions[col].width = w


def _clean(value):
    """Coerce a value into something openpyxl can store; ``None`` → empty cell."""
    if value is None:
        return ""
    if isinstance(value, (int, float, str, bool)):
        return value
    return str(value)


def _norm_sections(sections: Iterable[str] | str | None) -> set[str] | None:
    if sections is None:
        return None
    items = sections.split(",") if isinstance(sections, str) else list(sections)
    out = {str(s).strip().lower() for s in items if str(s).strip()}
    return out or None  # empty selection ⇒ treat as "all"


def _wanted(aliases: set[str], wanted: set[str] | None) -> bool:
    return wanted is None or bool(aliases & wanted)


# Column letter helper kept imported for callers extending the sheets.
__all__ = ["build_excel", "CRITICAL_RATE", "get_column_letter"]
