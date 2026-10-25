# web/api.py
"""КОРПУС C2 HTTP surface: JSON + SSE endpoints over the Plan-1 chat-agent core.

Mounted onto the existing ``web.app:app`` alongside the v0.1 Jinja routes (no v0.1
route is removed; they coexist until КОРПУС reaches parity — spec §10). The agent's
LLM client and the ``run_analysis`` re-run callable are *injected* into the router so
the HTTP layer never imports a real provider and is fully testable against the Plan-1
``FakeToolCallingClient``.
"""

from __future__ import annotations

import json
import re
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from agents.chat_agent import build_registry, run_turn, threads
from agents.chat_agent.context import assemble_messages
from agents.chat_agent.loop import stream_turn
from agents.chat_agent.prompt import CHAT_SYSTEM_PROMPT  # noqa: F401 — re-exported (tests / callers)
from agents.chat_agent.router import use_light_path
from models.scrubbing import learn
from agents.insight_agent import InsightOptions, compute_diff
from core import history
from core import settings as settings_mod
from core.settings import resolve_component
from web import chat_sse
from web.service import Upload, run_analysis


#: Titles a chat gets on creation; the first user question replaces them (auto-title).
_DEFAULT_TITLES = {"Новый чат", "Вопрос по анализу", ""}


def _auto_title(message: str, limit: int = 60) -> str:
    """Chat title from the first question: whitespace collapsed, cut at a word boundary."""
    t = " ".join((message or "").split())
    if len(t) <= limit:
        return t or "Новый чат"
    cut = t[:limit].rsplit(" ", 1)[0].rstrip(",.;:—-")
    return (cut or t[:limit]) + "…"


#: In-memory per-thread cancel registry. POST /chat/{id}/stop adds a thread_id here; the
#: live /chat stream checks membership between loop iterations and ends the turn (the «Стоп»
#: button). Module-level so the stop request (a SEPARATE HTTP call) and the in-flight stream
#: share it. Cleared when each turn ends.
CANCEL: set[str] = set()


def _test_key(name: str | None) -> str:
    """Normalize a run name to a «same test» key: drop the .xlsx extension and any group
    markers, so «… 001_группа 1.xlsx», «… 001_группа 2.xlsx» and «… 001 (4 групп)» all
    collapse to one test (groups of the same test become comparable; #13/#14)."""
    n = (name or "").lower().strip()
    n = re.sub(r"\.xlsx$", "", n)
    n = re.sub(r"\s*\(\s*\d+\s*групп[а-я]*\s*\)", "", n)  # « (4 групп)»
    n = re.sub(r"[_\-\s]*групп[а-я]*\s*[_\-]?\s*\d+", "", n)  # «_группа 2»
    return n.strip(" _-")


def _previous_comparable(run_id: str, root) -> dict | None:
    """The most recent run BEFORE ``run_id`` of the SAME course (and, when possible, the same
    group set) — the sensible «предыдущий» run to compare against. None if there's no
    comparable earlier run, so the agent says so instead of inventing an id or comparing a run
    with itself (#13)."""
    return history.previous_comparable(history.list_runs(root), run_id)


def _staged_uploads(thread: dict, root: Path | str) -> list[Upload]:
    """Rehydrate a thread's staged files: read each manifest entry's stored bytes back
    into a ``web.service.Upload`` (the shape ``run_analysis`` consumes). Entries whose
    stored file is missing are skipped so a partially-cleared staging dir never crashes."""
    base = threads.uploads_dir(thread["id"], root)
    out: list[Upload] = []
    entries = thread.get("uploads") or []
    # Files stay in the chat after a run; a new run uses the files not analysed yet, and
    # re-runs everything only when every file was already analysed («повтори анализ»).
    fresh = [u for u in entries if not u.get("analyzed_in")]
    for u in fresh or entries:
        path = base / u.get("stored", "")
        if path.exists():
            out.append(Upload(filename=u.get("filename", path.name), data=path.read_bytes()))
    return out


class ThreadCreate(BaseModel):
    title: str = "Новый чат"
    category: str = "Анализ"
    context: dict | None = None


class ThreadPatch(BaseModel):
    title: str | None = None
    category: str | None = None
    context: dict | None = None
    clear_messages: bool = False
    detach: bool = False  # explicitly clear the bound analysis/comparison (context → null)


class SettingsPut(BaseModel):
    components: dict = {}
    keys: dict = {}
    analysis_defaults: dict = {}   # model_group / deep / max_llm_calls / aspects of a new run


class ChatRequest(BaseModel):
    thread_id: str
    message: str
    effort: str = "high"


class ChatConfirmRequest(BaseModel):
    thread_id: str
    approve: bool


class DeleteRunsRequest(BaseModel):
    ids: list[str]
    delete_chats: bool = False  # also delete the chats bound to the deleted analyses


class RunPatch(BaseModel):
    name: str


class CompareRequest(BaseModel):
    run_id_a: str
    run_id_b: str


def build_router(
    *,
    chats_root: Path | str = threads.DEFAULT_ROOT,
    history_root: Path | str | None = None,
    settings_path: Path | str = settings_mod.DEFAULT_PATH,
    agent_client_factory=None,
    registry_factory=None,
    rerun=None,
) -> APIRouter:
    """Construct the C2 router. ``chats_root``/``history_root`` are injectable for tests."""
    router = APIRouter()
    chats_root = Path(chats_root)
    hist_root = Path(history_root) if history_root is not None else history.DEFAULT_ROOT

    def _default_client_factory(component_cfg: dict):
        # Real provider client is built in Plan 3; injected in tests. Until Plan 3,
        # calling /chat without an injected client raises a clear Russian error.
        raise RuntimeError("LLM-клиент агента ещё не подключён (Plan 3).")

    def _default_registry_factory(active_run_id, uploads):
        return build_registry(root=hist_root, active_run_id=active_run_id, rerun=rerun, uploads=uploads)

    client_factory = agent_client_factory or _default_client_factory
    reg_factory = registry_factory or _default_registry_factory

    @router.post("/threads")
    def create_thread(body: ThreadCreate) -> dict:
        thread = threads.new_thread(title=body.title, category=body.category, context=body.context)
        threads.save_thread(thread, root=chats_root)
        return thread

    def _flag_missing(meta: dict, known: set[str]) -> dict:
        """Mark a chat whose bound analysis was deleted (``run_missing``) — it stays readable
        but the UI must not let the user keep asking about data that no longer exists."""
        ids = threads.context_run_ids(meta.get("context"))
        return {**meta, "run_missing": bool(ids) and any(i not in known for i in ids)}

    def _run_names() -> dict:
        return {r.get("id"): r.get("name") for r in history.list_runs(hist_root) if isinstance(r, dict)}

    def _known_runs() -> set[str]:
        return {r.get("id") for r in history.list_runs(hist_root) if isinstance(r, dict)}

    @router.get("/threads")
    def list_threads() -> list[dict]:
        known = _known_runs()
        return [_flag_missing(m, known) for m in threads.list_threads(root=chats_root)]

    @router.get("/threads/{thread_id}")
    def get_thread(thread_id: str) -> dict:
        thread = threads.load_thread(thread_id, root=chats_root)
        if thread is None:
            raise HTTPException(status_code=404, detail="Чат не найден.")
        return _flag_missing(thread, _known_runs())

    @router.patch("/threads/{thread_id}")
    def patch_thread(thread_id: str, body: ThreadPatch) -> dict:
        thread = threads.load_thread(thread_id, root=chats_root)
        if thread is None:
            raise HTTPException(status_code=404, detail="Чат не найден.")
        if body.title is not None:
            thread["title"] = body.title
        if body.category is not None:
            thread["category"] = body.category
        if body.context is not None:
            thread["context"] = body.context
        if body.detach:
            thread["context"] = None
        if body.clear_messages:
            thread["messages"] = []
        threads.save_thread(thread, root=chats_root)
        return thread

    @router.delete("/threads/{thread_id}")
    def delete_thread(thread_id: str) -> dict:
        thread = threads.load_thread(thread_id, root=chats_root)
        if thread is None:
            raise HTTPException(status_code=404, detail="Чат не найден.")
        threads.delete_thread(thread_id, root=chats_root)
        return {"deleted": thread_id}

    @router.get("/settings")
    def get_settings() -> dict:
        overlay = settings_mod.load_overlay(path=settings_path)
        return settings_mod.ui_view(overlay=overlay)

    @router.put("/settings")
    def put_settings(body: SettingsPut) -> dict:
        # Merge into the stored overlay so an empty `keys` map does not wipe saved keys,
        # and a partial component PUT (e.g. only `params.effort`) does not clobber a
        # previously-saved provider/model or sibling params — deep-merge per component.
        overlay = settings_mod.load_overlay(path=settings_path)
        components = overlay.setdefault("components", {})
        for name, patch in (body.components or {}).items():
            cur = dict(components.get(name) or {})
            patch = dict(patch or {})
            merged_params = dict(cur.get("params") or {})
            merged_params.update(patch.get("params") or {})
            cur.update({k: v for k, v in patch.items() if k != "params"})
            if "params" in patch or "params" in cur:
                cur["params"] = merged_params
            components[name] = cur
        overlay.setdefault("keys", {}).update(body.keys or {})
        if body.analysis_defaults:
            # Merge into the stored defaults; invalid fields are dropped, never stored.
            stored = dict(overlay.get("analysis_defaults") or {})
            stored.update(settings_mod.sanitize_analysis_defaults(body.analysis_defaults))
            overlay["analysis_defaults"] = stored
        settings_mod.save_overlay(overlay, path=settings_path)
        return settings_mod.ui_view(overlay=overlay)

    @router.post("/chat")
    def chat(body: ChatRequest) -> StreamingResponse:
        def stream():
            thread = threads.load_thread(body.thread_id, root=chats_root)
            if thread is None:
                yield chat_sse.sse_frame("error", {"text": f"Чат {body.thread_id} не найден."})
                return
            unobserve = lambda: None  # noqa: E731 — set once the client exists
            try:
                ts = time.strftime("%Y-%m-%d %H:%M:%S")
                bound = threads.context_run_ids(thread.get("context"))
                if bound and not any(history.load_run(i, root=hist_root) for i in bound):
                    yield chat_sse.sse_frame("error", {"text": (
                        "Анализ, к которому привязан этот чат, удалён. Прикрепите другой анализ "
                        "или начните новый чат.")})
                    return
                thread["messages"].append({"role": "user", "text": body.message, "ts": ts})
                if thread.get("title") in _DEFAULT_TITLES and len(thread["messages"]) == 1:
                    thread["title"] = _auto_title(body.message)

                overlay = settings_mod.load_overlay(path=settings_path)
                component_cfg = resolve_component("chat_agent", overlay=overlay)
                client = client_factory(component_cfg)
                # Course names (questions / options / etalon) stay readable for the model: every
                # run loaded from here on (attached ones and whatever the tools open) feeds the
                # scrubber's allowlist; student identities remain masked.
                unobserve = history.add_load_observer(lambda r, c=client: learn(c, run=r))
                run_ids = threads.context_run_ids(thread.get("context"))
                runs = [r for r in (history.load_run(i, root=hist_root) for i in run_ids) if r]
                active_run_id = run_ids[0] if run_ids else None
                prev_run = _previous_comparable(run_ids[0], hist_root) if len(run_ids) == 1 else None
                staged = _staged_uploads(thread, chats_root)
                registry = reg_factory(active_run_id, staged)

                # Feed the system prompt + attached-analyses context + full thread history to
                # the model (spec §5). The context lists every run bound to this thread so the
                # model answers grounded and can compare any groups/runs without wandering
                # through list_runs.
                # «Лёгкий путь»: an ordinary question over an attached analysis is answered in
                # ONE model call from the injected digest; the tool loop is for questions that
                # need data outside it (see agents.chat_agent.router).
                light = use_light_path(body.message, n_runs=len(runs),
                                       staged_uploads=len(thread.get("uploads") or []))
                common = dict(prev_run=prev_run, uploads=thread.get("uploads"), names=_run_names())
                messages = assemble_messages(thread, runs=runs, **common)
                light_messages = assemble_messages(thread, runs=runs, light=True, **common) if light else None

                # Stream the turn LIVE: status → tool traces/cards → incremental answer tokens.
                # Clear any stale stop flag before we start so an old «Стоп» can't kill a fresh
                # turn; cancel() is checked between iterations so a NEW stop request ends this one.
                CANCEL.discard(body.thread_id)
                try:
                    for event, data in stream_turn(
                        client, registry, messages, effort=body.effort,
                        cancel=lambda: body.thread_id in CANCEL, light_messages=light_messages,
                    ):
                        if event == "done":
                            # Persist the assistant message (ordered blocks + the FULL tool_trace,
                            # exactly as run_turn would) BEFORE closing the turn. The wire frame
                            # carries only {blocks} per the contract; the client rebuilds its
                            # «Ход рассуждений» panel from the streamed `tool` events.
                            thread["messages"].append({
                                "role": "assistant", "blocks": data.get("blocks", []),
                                "tool_trace": data.get("tool_trace", []),
                                "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
                            })
                            thread.pop("pending_confirmation", None)
                            thread.pop("pending_effort", None)
                            threads.save_thread(thread, root=chats_root)
                            yield chat_sse.sse_frame("done", {"blocks": data.get("blocks", [])})
                        elif event == "confirm":
                            # Paused for confirmation: persist the pending tool call + the user's
                            # chosen effort so /chat/confirm can execute it directly (no model
                            # re-run — the model already proposed it). No assistant message yet.
                            thread["pending_confirmation"] = data
                            thread["pending_effort"] = body.effort
                            threads.save_thread(thread, root=chats_root)
                            yield chat_sse.sse_frame("confirm", data)
                        elif event == "stopped":
                            # User hit «Стоп»: persist nothing new, just end the turn.
                            yield chat_sse.sse_frame("stopped", {})
                        else:
                            yield chat_sse.sse_frame(event, data)
                finally:
                    CANCEL.discard(body.thread_id)
            except Exception as exc:  # noqa: BLE001 — never crash the stream; surface in Russian
                yield chat_sse.sse_frame("error", {"text": f"Ошибка агента: {exc}"})
            finally:
                unobserve()

        return StreamingResponse(stream(), media_type="text/event-stream")

    @router.post("/chat/{thread_id}/stop")
    def stop_chat(thread_id: str) -> dict:
        # Register a stop for this thread. An in-flight /chat stream sees it between loop
        # iterations and ends with a `stopped` event (the «Стоп» button — table-stakes for a
        # modern agent). Safe to call even when no turn is running; the next turn clears it.
        CANCEL.add(thread_id)
        return {"stopped": thread_id}

    @router.post("/chat/confirm")
    def chat_confirm(body: ChatConfirmRequest) -> StreamingResponse:
        def stream():
            thread = threads.load_thread(body.thread_id, root=chats_root)
            if thread is None:
                yield chat_sse.sse_frame("error", {"text": f"Чат {body.thread_id} не найден."})
                return
            unobserve = lambda: None  # noqa: E731 — set once the client exists
            try:
                pending = thread.get("pending_confirmation")
                if not body.approve:
                    blocks = [{"type": "text", "text": "Перезапуск анализа отменён."}]
                    yield chat_sse.sse_frame("status", {"text": chat_sse.STATUS_DONE})
                    yield chat_sse.sse_frame("token", {"text": blocks[0]["text"]})
                    thread.pop("pending_confirmation", None)
                    thread.pop("pending_effort", None)
                    thread["messages"].append({
                        "role": "assistant", "blocks": blocks, "tool_trace": [],
                        "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
                    })
                    threads.save_thread(thread, root=chats_root)
                    yield chat_sse.sse_frame("done", {"blocks": blocks})
                    return

                if not pending:
                    # Idempotent: a repeated confirm (double click / re-sent request) after the
                    # action already ran must not surface a scary error in the chat.
                    yield chat_sse.sse_frame("done", {"blocks": []})
                    return

                overlay = settings_mod.load_overlay(path=settings_path)
                component_cfg = resolve_component("chat_agent", overlay=overlay)
                client = client_factory(component_cfg)
                unobserve = history.add_load_observer(lambda r, c=client: learn(c, run=r))
                run_ids = threads.context_run_ids(thread.get("context"))
                runs = [r for r in (history.load_run(i, root=hist_root) for i in run_ids) if r]
                active_run_id = run_ids[0] if run_ids else None
                prev_run = _previous_comparable(run_ids[0], hist_root) if len(run_ids) == 1 else None
                staged = _staged_uploads(thread, chats_root)
                registry = reg_factory(active_run_id, staged)

                # 1) Execute the approved tool directly (no model re-propose). This calls
                #    the injected rerun exactly once and yields a render-ready card.
                tool = registry.get(pending["name"])
                tool_result = (tool["fn"](pending["arguments"]) if tool
                               else {"error": f"Неизвестный инструмент: {pending['name']}"})
                pre_blocks: list[dict] = []
                if isinstance(tool_result, dict) and "card" in tool_result:
                    pre_blocks.append({"type": "card", "card": tool_result["card"]})
                    yield chat_sse.sse_frame("card", {"card": tool_result["card"]})
                pre_trace = [{"name": pending["name"], "arguments": pending["arguments"],
                              "result": tool_result,
                              "summary": "Запуск анализа по файлам чата"
                              if pending["name"] == "run_analysis" else "Выполнено подтверждённое действие"}]

                # A successful run_analysis produces a NEW run: bind it to this chat's context
                # (so the model now answers over it) and drop the staged uploads — they have
                # been consumed. Persisted by the existing save in the done branch below.
                if (pending["name"] == "run_analysis" and isinstance(tool_result, dict)
                        and tool_result.get("data", {}).get("run_id")):
                    rid_new = tool_result["data"]["run_id"]
                    ids = threads.context_run_ids(thread.get("context")) + [rid_new]
                    thread["context"] = threads.context_with_runs(ids)
                    # Files stay in the chat for good (like any chat app): mark them as already
                    # analysed instead of deleting them, so later turns still «see» them.
                    for u in thread.get("uploads") or []:
                        u.setdefault("analyzed_in", rid_new)

                # BUG 3 (stale grounding): the just-created run was appended to the context
                # above, but `runs` was loaded from the OLD context (line ~443). RELOAD from
                # the now-updated context so zip(run_ids, runs) in _assemble_messages injects
                # the new run's summary/groups/hardest-questions — otherwise the closing prose
                # is ungrounded on the run it just produced.
                ids = threads.context_run_ids(thread.get("context"))
                runs = [r for r in (history.load_run(i, root=hist_root) for i in ids) if r]

                # 2) One model turn for the closing prose, with the tool result in context.
                messages = assemble_messages(
                    thread, runs=runs, prev_run=prev_run, uploads=thread.get("uploads"),
                    names=_run_names(),
                )
                # Inject the already-executed tool result as a SYSTEM note, NOT a bare
                # role:"tool" message — strict OpenAI providers reject a tool message with no
                # preceding assistant tool_calls (the tool ran directly here, not via the model).
                messages.append({"role": "system", "content": (
                    f"Результат выполненного действия «{pending['name']}»: "
                    f"{json.dumps(tool_result, ensure_ascii=False)}. "
                    "Кратко прокомментируй этот результат пользователю по-русски."
                )})
                # BUG 8: resume with the user's ORIGINAL effort (persisted at pause), not a
                # hardcoded «medium» — honour the режим the user chose for this turn.
                effort = thread.get("pending_effort") or "high"
                result = run_turn(client, registry, messages, effort=effort)

                # 3) Merge: executed-tool card/trace precede the model's narration.
                merged_blocks = pre_blocks + result.blocks
                merged_trace = pre_trace + result.tool_trace

                thread.pop("pending_confirmation", None)
                thread.pop("pending_effort", None)
                yielded_done = False
                for frame in chat_sse.frames_for_result(result):
                    if frame.startswith("event: card"):
                        continue  # cards already streamed in step 1 (pre_blocks)
                    if frame.startswith("event: done"):
                        thread["messages"].append({
                            "role": "assistant", "blocks": merged_blocks,
                            "tool_trace": merged_trace,
                            "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
                        })
                        threads.save_thread(thread, root=chats_root)
                        yield chat_sse.sse_frame("done", {"blocks": merged_blocks})
                        yielded_done = True
                        continue
                    yield frame
                if not yielded_done:
                    # Defensive: the narration turn paused again (should not happen on the
                    # single approved turn). Persist what we have and close cleanly.
                    thread["messages"].append({
                        "role": "assistant", "blocks": merged_blocks,
                        "tool_trace": merged_trace, "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
                    })
                    threads.save_thread(thread, root=chats_root)
                    yield chat_sse.sse_frame("done", {"blocks": merged_blocks})
            except Exception as exc:  # noqa: BLE001
                yield chat_sse.sse_frame("error", {"text": f"Ошибка агента: {exc}"})
            finally:
                unobserve()

        return StreamingResponse(stream(), media_type="text/event-stream")

    @router.post("/chat/{thread_id}/uploads")
    async def upload_to_thread(
        thread_id: str, files: list[UploadFile] = File(...)
    ) -> dict:
        # Stage files on a thread so the agent can later re-run an analysis over them. We
        # do NOT run the analysis here — the model first asks the user which file is the
        # «эталон» (see _assemble_messages uploads branch) before proposing run_analysis.
        thread = threads.load_thread(thread_id, root=chats_root)
        if thread is None:
            raise HTTPException(status_code=404, detail="Чат не найден.")
        staging = threads.uploads_dir(thread_id, chats_root)
        staging.mkdir(parents=True, exist_ok=True)
        manifest = thread.setdefault("uploads", [])
        for f in files:
            if f is None or not f.filename:
                continue
            data = await f.read()
            stored = uuid.uuid4().hex + Path(f.filename).suffix
            (staging / stored).write_bytes(data)
            kind = "etalon" if "эталон" in f.filename.lower() else "massiv"
            manifest.append(
                {"filename": f.filename, "stored": stored, "kind": kind, "size": len(data)}
            )
        threads.save_thread(thread, root=chats_root)
        return {"uploads": thread["uploads"]}

    @router.delete("/chat/{thread_id}/uploads/{stored}")
    def remove_thread_upload(thread_id: str, stored: str) -> dict:
        # The × on an attachment chip: drop ONE staged file (manifest entry + stored bytes).
        # `stored` must be an entry of this thread's manifest, so no path can escape staging.
        thread = threads.load_thread(thread_id, root=chats_root)
        if thread is None:
            raise HTTPException(status_code=404, detail="Чат не найден.")
        manifest = thread.get("uploads") or []
        if not any(u.get("stored") == stored for u in manifest):
            raise HTTPException(status_code=404, detail="Файл не найден.")
        (threads.uploads_dir(thread_id, chats_root) / stored).unlink(missing_ok=True)
        thread["uploads"] = [u for u in manifest if u.get("stored") != stored]
        threads.save_thread(thread, root=chats_root)
        return {"uploads": thread["uploads"]}

    # ------------------------------------------------------------------ analysis tabs
    # JSON / multipart surface for the non-chat tabs (Новый анализ / История / Сравнение).
    # These reuse web.service.run_analysis and core.history exactly as the v0.1 Jinja
    # routes do, but return JSON for the React UI. ``hist_root`` is threaded through so a
    # run saved via /analyze is immediately visible to /runs and /compare (and to tests).

    @router.post("/analyze")
    async def analyze(
        answers: list[UploadFile] = File(...),
        reference: UploadFile | None = File(None),
        model_group: str = Form("foreign"),
        mode: str = Form("all"),
        max_llm_calls: int = Form(0),
        course_id: str = Form("анализ"),
        use_insights: bool = Form(False),
        insight_blocks: list[str] = Form([]),
        insight_note: str = Form(""),
    ) -> dict:
        # One or several group files → one run with a per-group breakdown (web.service).
        uploads = [
            Upload(filename=a.filename, data=await a.read())
            for a in answers
            if a is not None and a.filename
        ]
        if not uploads:
            raise HTTPException(status_code=400, detail="Не приложен файл ответов пользователей.")
        ref = None
        if reference is not None and reference.filename:
            ref = Upload(filename=reference.filename, data=await reference.read())

        opts = InsightOptions.from_list(
            insight_blocks, custom=insight_note, enabled=bool(use_insights)
        )
        try:
            result = run_analysis(
                uploads, ref, course_id=course_id, model_group=model_group, mode=mode,
                max_llm_calls=max_llm_calls, insight_options=opts,
                history_root=hist_root,
            )
        except Exception as exc:  # noqa: BLE001 — config/key errors etc.: surface in Russian, never 500
            raise HTTPException(status_code=400, detail=f"Ошибка анализа: {exc}") from exc

        if result.get("error"):
            raise HTTPException(status_code=400, detail=result["error"])
        return result

    @router.get("/runs")
    def get_runs() -> list[dict]:
        return history.list_runs(root=hist_root)

    @router.get("/runs/{run_id}")
    def get_run(run_id: str) -> dict:
        run = history.load_run(run_id, root=hist_root)
        if run is None:
            raise HTTPException(status_code=404, detail="Анализ не найден.")
        return run

    def _drop_chats(removed: list[str], delete_chats: bool) -> int:
        """Delete the chats bound ONLY to removed analyses (or unbind the removed ids from
        multi-analysis chats). Without ``delete_chats`` chats are kept and shown as orphaned."""
        if not delete_chats or not removed:
            return 0
        gone = set(removed)
        n = 0
        for meta in threads.list_threads(root=chats_root):
            ids = threads.context_run_ids(meta.get("context"))
            if not ids or not (set(ids) & gone):
                continue
            left = [i for i in ids if i not in gone]
            if left:
                th = threads.load_thread(meta["id"], root=chats_root)
                if th is not None:
                    th["context"] = threads.context_with_runs(left)
                    threads.save_thread(th, root=chats_root)
            else:
                threads.delete_thread(meta["id"], root=chats_root)
                n += 1
        return n

    @router.delete("/runs/{run_id}")
    def delete_run(run_id: str, delete_chats: bool = False) -> dict:
        if not history.is_safe_id(run_id):
            raise HTTPException(status_code=400, detail="Недопустимый id анализа.")
        removed = history.delete_runs([run_id], root=hist_root)
        if not removed:
            raise HTTPException(status_code=404, detail="Анализ не найден.")
        out: dict = {"deleted": removed}
        if delete_chats:
            out["chats_deleted"] = _drop_chats(removed, True)
        return out

    @router.post("/runs/delete")
    def delete_runs_bulk(body: DeleteRunsRequest) -> dict:
        if not body.ids or not all(history.is_safe_id(i) for i in body.ids):
            raise HTTPException(status_code=400, detail="Недопустимый список id.")
        removed = history.delete_runs(body.ids, root=hist_root)
        out: dict = {"deleted": removed}
        if body.delete_chats:
            out["chats_deleted"] = _drop_chats(removed, True)
        return out

    @router.patch("/runs/{run_id}")
    def rename_run(run_id: str, body: RunPatch) -> dict:
        name = " ".join((body.name or "").split())
        if not name:
            raise HTTPException(status_code=400, detail="Название не может быть пустым.")
        if not history.is_safe_id(run_id) or not history.rename_run(run_id, name[:120], root=hist_root):
            raise HTTPException(status_code=404, detail="Анализ не найден.")
        return {"id": run_id, "name": name[:120]}

    @router.post("/compare")
    def compare_runs(body: CompareRequest) -> dict:
        if body.run_id_a == body.run_id_b:
            raise HTTPException(status_code=400, detail="Выберите два разных анализа.")
        a = history.load_run(body.run_id_a, root=hist_root)
        b = history.load_run(body.run_id_b, root=hist_root)
        if a is None or b is None:
            missing = body.run_id_a if a is None else body.run_id_b
            raise HTTPException(status_code=404, detail=f"Анализ не найден: {missing}")
        index = {m.get("id"): m for m in history.list_runs(hist_root) if isinstance(m, dict)}
        ma, mb = index.get(body.run_id_a, {}), index.get(body.run_id_b, {})
        # «Раньше» is always the earlier analysis, so +/− read as «стало лучше / хуже».
        swapped = bool(ma.get("created_at") and mb.get("created_at") and ma["created_at"] > mb["created_at"])
        if swapped:
            a, b, ma, mb = b, a, mb, ma
        diff = compute_diff(a, b)
        diff["meta_a"], diff["meta_b"] = ma, mb
        diff["swapped"] = swapped
        diff["same_course"] = history.course_key(ma) == history.course_key(mb) if ma and mb else None
        diff["comparable"] = diff["common_count"] > 0
        return diff

    return router
