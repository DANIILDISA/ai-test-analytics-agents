"""Low-level cell coercion helpers shared by the parsers (zero LLM tokens).

The exports are messy: dates may arrive as real ``datetime`` objects, as Excel
serial numbers, or as strings; scores are free text like ``"12 / 15 (80%)"``;
answer cells may be numbers, datetimes (Excel auto-coercion) or text. These
helpers normalise all of that deterministically.
"""

from __future__ import annotations

import re
import warnings
from datetime import datetime, timedelta

# Excel's day 0 is 1899-12-30 (accounting for the 1900 leap-year bug).
_EXCEL_EPOCH = datetime(1899, 12, 30)

# "12 / 15 (80%)", "12,5 из 20 (62,5 %)"  ->  points, max, pct (decimal comma allowed,
# "/" or "из" or "of" as the separator).
_NUM = r"\d+(?:[.,]\d+)?"
_SEP = r"(?:/|из|of)"
_SCORE_RE = re.compile(
    rf"(?P<points>{_NUM})\s*{_SEP}\s*(?P<max>{_NUM})\s*\(\s*(?P<pct>[\d.,]+)\s*%\s*\)"
)
# Fallback: bare "12 / 15" with no percentage.
_SCORE_FRACTION_RE = re.compile(rf"(?P<points>{_NUM})\s*{_SEP}\s*(?P<max>{_NUM})")
# Last fallback: a bare "80%" with no fraction.
_SCORE_PCT_RE = re.compile(r"(?P<pct>[\d.,]+)\s*%")


def _num(text: str) -> int | float:
    v = float(text.replace(",", "."))
    return int(v) if v.is_integer() else v


# How far the LMS-reported percentage may drift from the value computed straight
# from points/max before we treat it as an LMS calc/rounding error. 1.0 absorbs
# honest one-decimal rounding (e.g. 1/3 reported as "33%") without masking real
# mistakes (e.g. "12/15 (85%)" where 12/15 is 80%).
_PCT_TOLERANCE = 1.0

# String date formats observed / plausible in the exports.
_DATE_FORMATS = (
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
    "%d.%m.%Y %H:%M:%S",
    "%d.%m.%Y %H:%M",
    "%d.%m.%Y",
)


def norm_cell(value: object) -> str:
    """Stringify a cell to a trimmed ``str`` (``None`` -> "").

    Integer-valued floats collapse to ``"2"`` rather than ``"2.0"`` so numeric
    answers compare cleanly downstream.
    """
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    return str(value).strip()


def coerce_datetime(value: object) -> datetime | None:
    """Best-effort conversion of a date cell to ``datetime`` (or ``None``).

    Handles three shapes: a real ``datetime`` (passthrough), an Excel serial
    number (``int``/``float`` -> epoch + days), or a string in a known format.
    """
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            return _EXCEL_EPOCH + timedelta(days=float(value))
        except (OverflowError, ValueError):
            return None
    text = str(value).strip()
    if not text:
        return None
    # ISO first (covers "2025-10-23T10:20:00" and "2025-10-23 10:20:00").
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        pass
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    # Last resort: a serial number stored as a string.
    try:
        return _EXCEL_EPOCH + timedelta(days=float(text.replace(",", ".")))
    except ValueError:
        return None


def parse_score(raw: object) -> tuple[int | float, int | float, float]:
    """Parse a score cell -> ``(points, max, pct)``.

    Three shapes are recognised, in priority order:

    * ``"points / max (pct%)"`` — both the fraction and an LMS-reported
      percentage. The percentage is **recomputed** from ``points / max``; when
      the reported value disagrees beyond :data:`_PCT_TOLERANCE` it is treated as
      an LMS calc/rounding error, the computed value is preferred (so one bad
      cell does not compound across averages, medians and anomaly thresholds),
      and a warning is surfaced via :mod:`warnings`. When they agree the reported
      value is returned verbatim (normal path, unchanged).
    * ``"points / max"`` — fraction only; the percentage is computed.
    * ``"pct%"`` — a bare percentage with no fraction.

    Falls back to ``(0, 0, 0.0)`` when nothing matches.

    The mismatch warning is raised here because the course-level warnings channel
    (``CourseData.warnings``) is not reachable from this leaf helper without
    threading it through ``parse_answer_array``; the caller unpacks a 3-tuple, so
    the return contract is kept and :mod:`warnings` carries the signal instead.
    """
    text = norm_cell(raw)
    if not text:
        return (0, 0, 0.0)
    m = _SCORE_RE.search(text)
    if m:
        points = _num(m.group("points"))
        maximum = _num(m.group("max"))
        reported = float(m.group("pct").replace(",", "."))
        if maximum:
            computed = round(100.0 * points / maximum, 1)
            if abs(computed - reported) > _PCT_TOLERANCE:
                warnings.warn(
                    f"Несоответствие процента в оценке «{text}»: "
                    f"в файле {reported:g}%, по баллам {points}/{maximum} = "
                    f"{computed:g}%. Используется вычисленное значение.",
                    stacklevel=2,
                )
                return (points, maximum, computed)
        return (points, maximum, reported)
    m = _SCORE_FRACTION_RE.search(text)
    if m:
        points = _num(m.group("points"))
        maximum = _num(m.group("max"))
        pct = round(100.0 * points / maximum, 1) if maximum else 0.0
        return (points, maximum, pct)
    m = _SCORE_PCT_RE.search(text)
    if m:
        pct = float(m.group("pct").replace(",", "."))
        return (0, 0, pct)
    return (0, 0, 0.0)


_SERVICE_SHEET_RE = re.compile(
    r"^(сводка|информация|инфо|info|about|readme|summary|оглавление|содержание|титул\w*|"
    r"справка|легенда|описание|параметры|настройки|metadata|meta|notes?|примечани\w*)$"
)


def is_service_sheet(name: str) -> bool:
    """A sheet that is obviously not a test (summary / info / readme ...)."""
    return bool(_SERVICE_SHEET_RE.match(re.sub(r"\s+", " ", str(name)).strip().casefold()))


def unreadable_file_message(filename: str, exc: Exception | None = None) -> str:
    """Russian explanation for a file that cannot be opened at all (truncated / not xlsx).

    The technical exception text is deliberately NOT shown to the methodologist."""
    return (
        f"Файл «{filename}» повреждён или не является таблицей .xlsx, прочитать его не "
        f"удалось. Выгрузите его из СДО заново."
    )


_TRAIL_PUNCT = " .,;:!?…"


def normalize_question(text: object) -> str:
    """Normalise a question heading for grouping / fuzzy reference-linking.

    Lower-cases, collapses all whitespace (incl. NBSP / zero-width), treats ё as е and
    strips leading/trailing spaces and closing punctuation (``: . ? ! ;``) - enough to
    make the same question group together and link to the Эталон even when the two
    exports differ in incidental spacing, punctuation or ё/е spelling.
    """
    s = re.sub("[​‌‍﻿]", "", norm_cell(text))
    s = re.sub(r"\s+", " ", s).strip().casefold().replace("ё", "е")
    return s.strip(_TRAIL_PUNCT)
