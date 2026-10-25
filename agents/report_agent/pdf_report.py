"""PDF report through the Chromium-family browser the customer already has (no bundled engine).

The same ``report_model`` as the Word report is laid out as print-ready HTML (A4, Calibri/Segoe
typography) and printed to PDF by a headless Edge / Chrome / Yandex / Opera / Brave / Vivaldi.
Discovery order: the ``KORPUS_PDF_BROWSER`` environment override → the Windows default
browser (if Chromium-based) → well-known install paths + registry → ``PATH``.

If no browser can print, ``build_pdf`` does not raise: it returns the same HTML with a
«Ctrl+P → Сохранить как PDF» banner so the user can still get a PDF in one step.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from html import escape
from pathlib import Path

from agents.report_agent.report_model import build_report_model

_CHROMIUM_EXES = {"msedge", "chrome", "browser", "opera", "launcher", "brave", "vivaldi", "chromium", "atom"}
_PRINT_TIMEOUT = 90

BANNER_HTML = (
    '<div id="pdf-banner">PDF не создан автоматически: на компьютере не найден браузер на Chromium '
    "(Edge, Chrome, Яндекс Браузер, Opera, Brave). Нажмите <b>Ctrl+P</b> и выберите "
    "«Сохранить как PDF».</div>"
)


@dataclass
class PdfOutcome:
    ok: bool
    data: bytes = b""        # the PDF when ok, else the printable HTML (with banner) as UTF-8
    reason: str = ""         # RU explanation when not ok


# ------------------------------------------------------------------ html
_CSS = """
@page { size: A4; margin: 18mm 16mm 18mm 16mm; }
* { box-sizing: border-box; }
body { font-family: Calibri, "Segoe UI", Arial, sans-serif; font-size: 10.5pt; line-height: 1.5;
       color: #1f2937; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.eyebrow { font-size: 9.5pt; font-weight: 700; letter-spacing: .06em; color: #1853dc; text-transform: uppercase; }
h1 { font-size: 24pt; line-height: 1.2; margin: 4px 0 8px; }
.meta { margin: 0; }
.meta b { color: #6b7280; font-weight: 600; }
h2 { font-size: 15pt; color: #1853dc; margin: 26px 0 10px; padding-bottom: 4px; border-bottom: 2px solid #1853dc;
     break-after: avoid; }
h3 { font-size: 12pt; margin: 16px 0 6px; break-after: avoid; }
p { margin: 0 0 7px; }
ul { margin: 0 0 8px; padding-left: 18px; }
li { margin: 0 0 5px; }
.muted { color: #6b7280; }
.kpis { display: flex; gap: 10px; }
.kpi { flex: 1; background: #f3f6fd; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 14px; }
.kpi .v { font-size: 22pt; font-weight: 700; color: #1853dc; line-height: 1.1; }
.kpi .l { font-size: 9pt; color: #6b7280; margin-top: 4px; }
.kpi .h { font-size: 8.5pt; color: #6b7280; }
.ai { max-width: 160mm; }
table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
thead { display: table-header-group; }
th { background: #1853dc; color: #fff; text-align: left; padding: 6px 8px; }
td { border: 1px solid #d1d5db; padding: 6px 8px; vertical-align: top; }
tr { break-inside: avoid; }
tbody tr:nth-child(even) td { background: #f9fafb; }
td.rate { color: #c2410c; font-weight: 700; white-space: nowrap; }
.warn { color: #c2410c; font-size: 8.5pt; font-style: italic; margin-top: 3px; }
.method li { color: #6b7280; font-size: 9.5pt; margin-bottom: 3px; }
#pdf-banner { background: #fff3cd; border: 1px solid #e0b100; color: #533f03; padding: 10px 16px;
              margin: 0 0 14px; font: 14px Arial, sans-serif; }
@media print { #pdf-banner { display: none; } }
"""


def _block_html(items: list[tuple[str, str]]) -> str:
    out: list[str] = []
    ul: list[str] = []
    for kind, text in items:
        if kind == "li":
            ul.append(f"<li>{escape(text)}</li>")
            continue
        if ul:
            out.append("<ul>" + "".join(ul) + "</ul>")
            ul = []
        out.append(f"<p>{escape(text)}</p>")
    if ul:
        out.append("<ul>" + "".join(ul) + "</ul>")
    return "".join(out)


def render_html(m: dict, banner: bool = False) -> str:
    """Print-ready HTML of a report model (``banner`` adds the «Ctrl+P» hint for the fallback)."""
    groups = ", ".join(m["groups"]) if m["groups"] else "без разбивки на группы"
    parts = [
        '<!doctype html><html lang="ru"><head><meta charset="utf-8">',
        f"<title>{escape(m['title'])} — {escape(m['name'])}</title><style>{_CSS}</style></head><body>",
        BANNER_HTML if banner else "",
        f'<div class="eyebrow">{escape(m["title"])}</div><h1>{escape(m["name"])}</h1>',
        f'<p class="meta"><b>Дата анализа:</b> {escape(m["date"])}</p>',
        f'<p class="meta"><b>Группы:</b> {escape(groups)}</p>',
    ]
    if m["scope"]:
        parts.append(f'<p class="meta"><b>Охват:</b> {escape(m["scope"])}</p>')

    parts.append("<h2>Ключевые показатели</h2><div class=\"kpis\">")
    for k in m["kpis"]:
        hint = f'<div class="h">{escape(k["hint"])}</div>' if k.get("hint") else ""
        parts.append(
            f'<div class="kpi"><div class="v">{escape(k["value"])}</div>'
            f'<div class="l">{escape(k["label"])}</div>{hint}</div>'
        )
    parts.append("</div>")

    parts.append("<h2>ИИ-выводы</h2>")
    if not m["ai_blocks"]:
        parts.append(
            '<p class="muted">Глубокий анализ с ИИ для этого анализа не запускался, поэтому ИИ-выводов нет. '
            "Числовые результаты — в таблице ниже и в Excel-выгрузке.</p>"
        )
    for b in m["ai_blocks"]:
        parts.append(f'<div class="ai"><h3>{escape(b["title"])}</h3>{_block_html(b["items"])}</div>')

    parts.append("<h2>Критические вопросы</h2>")
    if not m["critical"]:
        parts.append(
            '<p class="muted">Критических вопросов нет: ни по одному вопросу доля верных ответов '
            "не опустилась ниже порога.</p>"
        )
    else:
        parts.append(
            f'<p class="muted">Вопросов с низкой долей верных ответов: {m["critical_total"]}. Сначала самые трудные.</p>'
            "<table><thead><tr><th style=\"width:42%\">Вопрос</th><th>Верно</th>"
            "<th style=\"width:26%\">Типичный неверный ответ</th><th style=\"width:22%\">Верный ответ</th></tr></thead><tbody>"
        )
        for q in m["critical"]:
            correct = escape(q["correct"]) if q["correct"] else '<span class="muted">нет в эталоне</span>'
            warn = '<div class="warn">Возможна ошибка в эталоне: проверьте ключ.</div>' if q["key_suspect"] else ""
            parts.append(
                f'<tr><td>{escape(q["question"])}</td><td class="rate">{escape(q["rate"])}</td>'
                f'<td>{escape(q["wrong"]) if q["wrong"] else "—"}</td><td>{correct}{warn}</td></tr>'
            )
        parts.append("</tbody></table>")
        if m["critical_more"]:
            parts.append(f'<p class="muted">Ещё вопросов: {m["critical_more"]} — полный список в Excel-выгрузке.</p>')

    if m["data_notes"]:
        parts.append("<h2>Замечания к данным</h2><ul>" + "".join(f"<li>{escape(t)}</li>" for t in m["data_notes"]) + "</ul>")
    parts.append("<h2>Методика</h2><ul class=\"method\">" + "".join(f"<li>{escape(t)}</li>" for t in m["method"]) + "</ul>")
    parts.append("</body></html>")
    return "".join(parts)


# ------------------------------------------------------------------ browser discovery
def _exe_from_command(cmd: str) -> str | None:
    cmd = os.path.expandvars(cmd.strip())
    m = re.match(r'^"([^"]+)"', cmd) or re.match(r"^(\S+\.exe)", cmd, re.I)
    return m.group(1) if m else None


def _is_chromium_exe(path: str) -> bool:
    p = Path(path)
    return p.stem.lower() in _CHROMIUM_EXES and (p.suffix.lower() == ".exe" or sys.platform != "win32")


def _default_browser() -> str | None:
    if sys.platform != "win32":
        return None
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice",
        ) as k:
            prog_id = winreg.QueryValueEx(k, "ProgId")[0]
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, prog_id + r"\shell\open\command") as k:
            cmd = winreg.QueryValueEx(k, "")[0]
    except OSError:
        return None
    exe = _exe_from_command(cmd)
    return exe if exe and os.path.isfile(exe) and _is_chromium_exe(exe) else None


def _known_locations() -> list[str]:
    env = os.environ
    bases = [env.get("ProgramFiles", r"C:\Program Files"), env.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
             env.get("LOCALAPPDATA", "")]
    rel = [
        r"Microsoft\Edge\Application\msedge.exe", r"Google\Chrome\Application\chrome.exe",
        r"Yandex\YandexBrowser\Application\browser.exe", r"BraveSoftware\Brave-Browser\Application\brave.exe",
        r"Vivaldi\Application\vivaldi.exe", r"Chromium\Application\chrome.exe",
        r"Opera\opera.exe", r"Opera GX\opera.exe", r"Programs\Opera\opera.exe", r"Programs\Opera GX\opera.exe",
    ]
    return [os.path.join(b, r) for b in bases if b for r in rel]


def _registry_browsers() -> list[str]:
    if sys.platform != "win32":
        return []
    import winreg

    found: list[str] = []
    for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        for name in ("msedge.exe", "chrome.exe", "browser.exe", "opera.exe", "brave.exe", "vivaldi.exe"):
            try:
                with winreg.OpenKey(root, rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{name}") as k:
                    p = winreg.QueryValueEx(k, "")[0]
                if p:
                    found.append(os.path.expandvars(p.strip('"')))
            except OSError:
                pass
    return found


def candidate_browsers() -> list[str]:
    """Ordered, de-duplicated list of existing Chromium-family executables to try."""
    cands: list[str] = []
    if os.environ.get("KORPUS_PDF_BROWSER"):
        cands.append(os.path.expandvars(os.environ["KORPUS_PDF_BROWSER"]))
    d = _default_browser()
    if d:
        cands.append(d)
    cands += [p for p in _known_locations() + _registry_browsers() if _is_chromium_exe(p)]
    for name in ("msedge", "google-chrome", "chromium", "chromium-browser", "chrome", "brave-browser"):
        w = shutil.which(name)
        if w:
            cands.append(w)
    seen, out = set(), []
    for p in cands:
        key = os.path.normcase(os.path.abspath(p))
        if key not in seen and os.path.isfile(p):
            seen.add(key)
            out.append(p)
    return out


# ------------------------------------------------------------------ printing
def is_valid_pdf(path: Path) -> bool:
    try:
        size = path.stat().st_size
        if not path.is_file() or size < 1000:
            return False
        with open(path, "rb") as f:
            head = f.read(5)
            f.seek(-min(2048, size), 2)
            tail = f.read()
        return head.startswith(b"%PDF") and b"%%EOF" in tail
    except OSError:
        return False


def _print_with_browser(exe: str, html_file: Path) -> bytes | None:
    for headless in ("--headless=new", "--headless"):
        with tempfile.TemporaryDirectory(prefix="korpus_pdf_prof_", ignore_cleanup_errors=True) as prof:
            tmp_pdf = Path(prof) / "out.pdf"
            cmd = [exe, headless, "--disable-gpu", "--no-pdf-header-footer", "--no-first-run",
                   "--no-default-browser-check", f"--user-data-dir={prof}",
                   f"--print-to-pdf={tmp_pdf}", html_file.as_uri()]
            try:
                subprocess.run(cmd, timeout=_PRINT_TIMEOUT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               stdin=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            except (subprocess.TimeoutExpired, OSError):
                continue
            if is_valid_pdf(tmp_pdf):
                return tmp_pdf.read_bytes()
    return None


_cache: dict[str, str] = {}   # per-process: the browser that worked last


def build_pdf(result: dict, meta: dict | None = None) -> PdfOutcome:
    """Render a saved run to PDF. Never raises for a missing browser — see ``PdfOutcome``."""
    m = build_report_model(result, meta)
    cands = candidate_browsers()
    cached = _cache.get("browser")
    if cached and os.path.isfile(cached):
        cands = [cached] + [c for c in cands if os.path.normcase(c) != os.path.normcase(cached)]
    if cands:
        with tempfile.TemporaryDirectory(prefix="korpus_pdf_html_", ignore_cleanup_errors=True) as td:
            html_file = Path(td) / "report.html"
            html_file.write_text(render_html(m), encoding="utf-8")
            for exe in cands:
                data = _print_with_browser(exe, html_file)
                if data:
                    _cache["browser"] = exe
                    return PdfOutcome(True, data)
    reason = ("PDF не создан автоматически: подходящий браузер (Edge, Chrome, Яндекс Браузер, Opera, Brave) "
              "не найден или не смог напечатать PDF. Открыт печатный вариант — нажмите Ctrl+P и выберите "
              "«Сохранить как PDF».")
    return PdfOutcome(False, render_html(m, banner=True).encode("utf-8"), reason)
