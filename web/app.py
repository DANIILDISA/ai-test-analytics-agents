"""FastAPI web app — the methodologist-facing prototype (Phase 4).

A thin shell over ``web.service`` (which wraps ``pipeline.runner`` + the insight agent):
upload form, synchronous run, Russian report (tables + AI commentary + data suggestions),
run history, and a two-analysis comparison. Single-user, local, no auth. Charts /
background jobs / Excel export come later.

Run:  uvicorn web.app:app --reload   →  http://127.0.0.1:8000
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, FastAPI, File, Form, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.templating import Jinja2Templates

from agents.insight_agent import BLOCK_TITLES, InsightOptions, compare
from agents.report_agent.excel_generator import build_excel
from agents.report_agent.generator import render_text
from core import history
from web.service import Upload, run_analysis

BASE = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(BASE / "templates"))
templates.env.globals["BLOCK_TITLES"] = BLOCK_TITLES

app = FastAPI(title="TestAnalyzer")

from web.api import build_router


def _agent_client_factory(component_cfg: dict):
    """Build the real tool-calling chat client for the resolved ``chat_agent`` component.

    ``component_cfg`` is ``{provider, model, params}`` from ``core.settings.resolve_component``.
    The provider-level transport settings (base_url, api_key_env, scope_env, verify_ssl,
    reasoning) are NOT in that dict, so we read them from the matching ``models`` group in
    ``config.yaml`` — keeping the "nothing hardcoded in Python" rule. The API key is resolved
    via ``core.settings.resolve_key`` (UI overlay > .env), then a per-component ``ModelConfig``
    is handed to ``models.build_tool_client``.

    Tool support: the config.yaml default (deepseek/deepseek-v4-flash on OpenRouter) advertises
    native function-calling on OpenRouter (verified 2026-06-24: supported_parameters includes
    "tools"), so OpenRouter uses native FC and GigaChat uses the ReAct text fallback — exactly
    as ``build_tool_client`` dispatches. The OpenRouter tool client falls back to ReAct if a
    model lacks tool support, so swapping the chat_agent model never breaks the live chat.
    """
    from core.config import ConfigError, ModelConfig, load_config
    from core.settings import resolve_key
    from models import build_tool_client

    provider = str(component_cfg.get("provider", "")).lower()
    model = component_cfg.get("model")
    params = component_cfg.get("params") or {}

    # Provider transport defaults come from the matching config.yaml group (require_key=False
    # so resolution never needs a secret present here — we resolve the key ourselves below).
    cfg = load_config(require_key=False)
    group = next((mc for mc in cfg.models.values() if mc.provider.lower() == provider), None)
    if group is None:
        raise ConfigError(f"Нет группы моделей с провайдером {provider!r} в config.yaml.")

    mc = ModelConfig(
        provider=group.provider,
        model=model or group.model,
        api_key_env=group.api_key_env,
        base_url=group.base_url,
        fallback_base_url=group.fallback_base_url,
        fallback_models=list(group.fallback_models),
        max_retries=group.max_retries,
        retry_backoff=group.retry_backoff,
        rate_limit_retries=group.rate_limit_retries,
        rate_limit_backoff=group.rate_limit_backoff,
        rate_limit_max_wait=group.rate_limit_max_wait,
        scope_env=group.scope_env,
        reasoning=group.reasoning,
        verify_ssl=group.verify_ssl,
        max_tokens=int(params.get("max_tokens", group.max_tokens)),
        temperature=float(params.get("temperature", group.temperature)),
    )
    mc.api_key = resolve_key(group.api_key_env)
    if group.scope_env:
        mc.scope = resolve_key(group.scope_env)
    return build_tool_client(mc)


def _agent_rerun(params: dict, uploads: list) -> dict:
    """Injected callable for the confirm-gated ``run_analysis`` chat tool.

    Runs a real analysis over the chat's staged files via ``web.service.run_analysis``.
    The «эталон» (reference) is resolved EXPLICITLY first — by ``params["reference_filename"]``
    (case-insensitive filename match) — then by the legacy «эталон»-in-filename heuristic, then
    None; everything else is the массив (answers). This closes the silent-wrong-key bug: a
    normally-named key file is no longer mistaken for a student answer. When the reference can't
    be resolved and more than one file is staged, we do NOT grade blind against an arbitrary file
    — we return a Russian error asking the user to name the эталон.

    The run honours the model the user configured for the «analysis» component in Settings
    (UI > config.yaml): its provider is mapped to the matching ``config.yaml`` model group, so a
    chat-triggered run uses the SAME model as the «Новый анализ» screen — not a forced foreign
    group (the confirm dialog no longer claims «иностранная модель»). Default runs are free
    (``max_llm_calls=0``) and call no model at all. The ИИ-выводы (insight commentary) are built
    from ``params["insight_blocks"]`` / ``insight_note`` so the chat can request a CONFIGURED,
    end-to-end run; an empty selection means no commentary (current behaviour). Without a массив
    there is nothing to grade, so we return a clear Russian error instead of calling the runner.

    ``run_analysis`` is imported inside the call so a test (and the SSE confirm path) sees the
    current ``web.service.run_analysis`` — patching it is honoured at call time. The returned
    shape matches the tool's contract: an ``{"error": …}`` is surfaced verbatim, otherwise the
    runner's result dict (with ``run_id``) is wrapped into a card by the chat tool.
    """
    from core.config import load_config
    from core.settings import load_overlay, resolve_component
    from web.service import run_analysis as svc_run

    # (1) explicit reference_filename (case-insensitive) → (2) «эталон»-in-name heuristic → (3) None.
    ref_name = str(params.get("reference_filename") or "").strip().lower()
    reference = None
    if ref_name:
        reference = next((u for u in uploads if u.filename.lower() == ref_name), None)
    if reference is None:
        reference = next((u for u in uploads if "эталон" in u.filename.lower()), None)

    massiv = [u for u in uploads if u is not reference]
    if not massiv:
        return {"error": "Не приложен массив ответов пользователей (.xlsx)."}
    # No reference resolved but several files are staged → we can't tell which is the эталон,
    # and grading free-text answers against the wrong key is a correctness bug. Surface it.
    if reference is None and len(uploads) > 1:
        return {
            "error": "Не удалось определить эталонный файл. Укажите, какой из загруженных "
            "файлов является эталоном (reference_filename)."
        }

    # A chat-triggered run is the SAME run as the «Новый анализ» button: it uses the analysis
    # defaults from Settings (model group, ИИ-разбор on/off, call budget, ИИ-выводы blocks).
    # The model may still narrow blocks/budget explicitly, but its silence no longer means
    # «код-только» — that produced weaker runs than the UI's and confused methodologists.
    from core.settings import resolve_analysis_defaults

    overlay = load_overlay()
    d = resolve_analysis_defaults(overlay=overlay)
    deep = bool(d.get("deep", True))
    raw_blocks = params.get("insight_blocks")
    blocks = list(raw_blocks) if isinstance(raw_blocks, (list, tuple, set)) and raw_blocks else list(d.get("aspects") or [])
    insight_options = InsightOptions.from_list(
        blocks, custom=str(params.get("insight_note") or ""), enabled=deep and bool(blocks)
    )
    try:
        calls = int(params.get("max_llm_calls") or 0)
    except (TypeError, ValueError):
        calls = 0
    if calls <= 0:
        calls = int(d.get("max_llm_calls") or 0) if deep else 0

    # Model: the provider chosen for the «analysis» component in Settings (gigachat →
    # "russian", openrouter → "foreign"), else the analysis defaults' group.
    cfg = load_config(require_key=False)
    provider = str(resolve_component("analysis", overlay=overlay).get("provider", "")).lower()
    group = next((k for k, mc in cfg.models.items() if mc.provider.lower() == provider), None)
    if group is None and d.get("model_group") in cfg.models:
        group = d.get("model_group")

    return svc_run(
        massiv,
        reference,
        course_id=params.get("course_id", "анализ"),
        model_group=group,
        mode=params.get("mode", "all"),
        max_llm_calls=calls,
        insight_options=insight_options,
    )


app.include_router(
    build_router(agent_client_factory=_agent_client_factory, rerun=_agent_rerun)
)


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")


@app.post("/analyze", response_class=HTMLResponse)
async def analyze(
    request: Request,
    answers: UploadFile = File(...),
    reference: UploadFile | None = File(None),
    model_group: str = Form("foreign"),
    mode: str = Form("all"),
    use_llm: str | None = Form(None),
    max_llm_calls: int = Form(400),
    use_insights: str | None = Form(None),
    insight_blocks: list[str] = Form([]),
    insight_note: str = Form(""),
):
    ans = Upload(filename=answers.filename or "массив.xlsx", data=await answers.read())
    ref = None
    if reference is not None and reference.filename:
        ref = Upload(filename=reference.filename, data=await reference.read())

    opts = InsightOptions.from_list(insight_blocks, custom=insight_note, enabled=bool(use_insights))
    calls = max_llm_calls if use_llm else 0
    try:
        result = run_analysis(
            ans, ref, model_group=model_group, mode=mode,
            max_llm_calls=calls, insight_options=opts,
        )
    except Exception as exc:  # noqa: BLE001 — config/key errors etc.: show, never crash the page
        return templates.TemplateResponse(
            request=request, name="report.html", context={"error": f"Ошибка: {exc}"}
        )

    return templates.TemplateResponse(
        request=request,
        name="report.html",
        context={
            "rid": result.get("run_id"),
            "error": result.get("error"),
            "answer": result.get("answer") or {},
            "time": result.get("time") or {},
            "insights": result.get("insights") or {},
            "warnings": result.get("warnings") or [],
            "text": "" if result.get("error") else render_text(result),
        },
    )


@app.get("/history", response_class=HTMLResponse)
def history_page(request: Request):
    return templates.TemplateResponse(
        request=request, name="history.html", context={"runs": history.list_runs()}
    )


@app.post("/compare", response_class=HTMLResponse)
def compare_runs(
    request: Request,
    ids: list[str] = Form([]),
    model_group: str = Form("foreign"),
    narrate: str | None = Form(None),
):
    if len(ids) != 2:
        return templates.TemplateResponse(
            request=request, name="compare.html",
            context={"error": "Выберите ровно два анализа для сравнения."},
        )
    a, b = history.load_run(ids[0]), history.load_run(ids[1])
    if a is None or b is None:
        return templates.TemplateResponse(
            request=request, name="compare.html",
            context={"error": "Один из выбранных анализов не найден."},
        )

    client = None
    if narrate:
        try:
            from core.config import load_config
            from models import get_client

            client = get_client(load_config(model_group=model_group, require_key=True))
        except Exception:  # noqa: BLE001 — narrative is optional; fall back to diff-only
            client = None

    if client is not None:
        from models.scrubbing import learn
        learn(client, run=a)
        learn(client, run=b)
    out = compare(a, b, client=client)
    return templates.TemplateResponse(
        request=request, name="compare.html",
        context={"diff": out["diff"], "narrative": out["narrative"]},
    )


# Report downloads live on their own router so the production server (web.serve) can
# reuse them verbatim without pulling in the legacy Jinja pages. Included on the legacy
# ``app`` below, so existing routes/tests are unchanged.
download_router = APIRouter()

XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _attachment(cyr_name: str, ascii_name: str) -> dict[str, str]:
    """Content-Disposition header carrying a Cyrillic filename.

    The header value must be latin-1 encodable, so the Russian name goes through the
    RFC 5987 ``filename*=UTF-8''…`` slot (percent-encoded) while ``filename=`` keeps an
    ASCII fallback for older clients.
    """
    return {
        "Content-Disposition": (
            f'attachment; filename="{ascii_name}"; '
            f"filename*=UTF-8''{quote(cyr_name)}"
        )
    }


def _sections_param(sections: str | None) -> list[str] | None:
    """Parse ?sections=a,b,c into a list; absent/blank ⇒ None (all sections)."""
    if not sections:
        return None
    picked = [s.strip() for s in sections.split(",") if s.strip()]
    return picked or None


@download_router.get("/download/{rid}.json")
def download(rid: str):
    result = history.load_run(rid)
    if result is None:
        return JSONResponse({"error": "Результат не найден"}, status_code=404)
    data = json.dumps(result, ensure_ascii=False, indent=2).encode("utf-8")
    return Response(
        content=data,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="report_{rid}.json"'},
    )


def _meta_of(rid: str) -> dict:
    return next((m for m in history.list_runs() if isinstance(m, dict) and m.get("id") == rid), {})


def _report_stem(rid: str, result: dict) -> str:
    """Readable download name: «ЭК 069 — отчёт 2026-10-10 00-40» (course + date of the run).

    Falls back to the run id when the course is unknown."""
    meta = _meta_of(rid)
    course = str(result.get("course_id") or meta.get("course_id") or "").strip()
    stamp = str(meta.get("created_at") or "")[:16].replace(":", "-")
    if course and course.lower() != "анализ":
        return f"{course} — отчёт {stamp}".strip() if stamp else f"{course} — отчёт {rid}"
    return f"отчёт-{rid}"


@download_router.get("/download/{rid}.xlsx")
def download_xlsx(rid: str, sections: str | None = None):
    result = history.load_run(rid)
    if result is None:
        return JSONResponse({"error": "Результат не найден"}, status_code=404)
    data = build_excel(result, sections=_sections_param(sections))
    return Response(
        content=data,
        media_type=XLSX_MEDIA,
        headers=_attachment(f"{_report_stem(rid, result)}.xlsx", f"report_{rid}.xlsx"),
    )


DOCX_MEDIA = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


@download_router.get("/download/{rid}.docx")
def download_docx(rid: str):
    """Word report: title, KPIs, the four AI blocks, critical questions, methodology."""
    from agents.report_agent.docx_report import build_docx

    result = history.load_run(rid)
    if result is None:
        return JSONResponse({"error": "Результат не найден"}, status_code=404)
    data = build_docx(result, _meta_of(rid))
    return Response(
        content=data,
        media_type=DOCX_MEDIA,
        headers=_attachment(f"{_report_stem(rid, result)}.docx", f"report_{rid}.docx"),
    )


@download_router.get("/download/{rid}.pdf")
def download_pdf(rid: str):
    """PDF report (printed by the Chromium-family browser on the machine).

    If no browser can print, the same report comes back as printable HTML (header
    ``X-Report-Fallback: html``, no attachment) so the UI can open it for Ctrl+P."""
    from agents.report_agent.pdf_report import build_pdf

    result = history.load_run(rid)
    if result is None:
        return JSONResponse({"error": "Результат не найден"}, status_code=404)
    out = build_pdf(result, _meta_of(rid))
    if out.ok:
        return Response(
            content=out.data,
            media_type="application/pdf",
            headers=_attachment(f"{_report_stem(rid, result)}.pdf", f"report_{rid}.pdf"),
        )
    return Response(
        content=out.data,
        media_type="text/html; charset=utf-8",
        headers={"X-Report-Fallback": "html"},
    )


@download_router.get("/download/{rid}.txt")
def download_txt(rid: str, sections: str | None = None):
    result = history.load_run(rid)
    if result is None:
        return JSONResponse({"error": "Результат не найден"}, status_code=404)
    data = render_text(
        result, name=_meta_of(rid).get("name"), sections=_sections_param(sections)
    ).encode("utf-8")
    return Response(
        content=data,
        media_type="text/plain; charset=utf-8",
        headers=_attachment(f"{_report_stem(rid, result)}.txt", f"report_{rid}.txt"),
    )


app.include_router(download_router)
