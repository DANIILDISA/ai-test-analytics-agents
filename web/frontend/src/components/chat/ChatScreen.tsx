// web/frontend/src/components/chat/ChatScreen.tsx
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, Bot, MessageSquarePlus, Square, X } from "lucide-react";
import { ThreadSidebar } from "@/components/chat/ThreadSidebar";
import { ContextBar } from "@/components/chat/ContextBar";
import { MessageList } from "@/components/chat/MessageList";
import { Composer } from "@/components/chat/Composer";
import { StagedFiles } from "@/components/chat/StagedFiles";
import { ConfirmDialog } from "@/components/chat/ConfirmDialog";
import { courseLabel, formatDateTime } from "@/lib/runs";
import { contextRunIds } from "@/types/chat";
import type {
  ThreadMeta,
  Thread,
  ThreadMessage,
  AssistantMessage,
  Block,
  Effort,
  ChatEvent,
  ConfirmEvent,
  ToolTraceEntry,
  Settings,
} from "@/types/chat";
import type { ChatRequest, ConfirmRequest } from "@/api/chatStream";
import type { ChatUpload, NewThreadRequest, RunMeta, ThreadPatch } from "@/api/client";

/** A thread plus its server-classified staged uploads (массив/эталон). The REST
 *  `Thread` carries `uploads` at runtime; the type is optional so a freshly-created
 *  thread (no uploads yet) still fits. */
type ThreadWithUploads = Thread & { uploads?: ChatUpload[] };

const DISCLAIMER =
  "Агент отвечает по данным привязанного анализа. Ответы могут содержать статистические оценки";

/** Injected API surface — real impls are bound in App (Task 11); faked in tests. */
export interface ChatApi {
  listThreads: () => Promise<ThreadMeta[]>;
  getThread: (id: string) => Promise<Thread>;
  createThread: (req: NewThreadRequest) => Promise<Thread>;
  getSettings: () => Promise<Settings>;
  listRuns: () => Promise<RunMeta[]>;
  patchThread: (id: string, patch: ThreadPatch) => Promise<Thread>;
  deleteThread: (id: string) => Promise<void>;
  uploadFiles: (id: string, files: File[]) => Promise<{ uploads: ChatUpload[] }>;
  // DELETE one staged attachment (× on its chip) — persisted per thread server-side.
  removeUpload: (id: string, stored: string) => Promise<{ uploads: ChatUpload[] }>;
  streamConfirm: (req: ConfirmRequest, onEvent: (e: ChatEvent) => void) => Promise<void>;
  // `signal` lets the «Стоп» button abort the in-flight SSE (real impl: chatStream.streamChat).
  streamChat: (req: ChatRequest, onEvent: (e: ChatEvent) => void, signal?: AbortSignal) => Promise<void>;
  // POST /chat/:id/stop — server-side cancel of the running turn (wired in App.tsx separately).
  stopChat: (id: string) => Promise<void>;
}

export function ChatScreen({ api }: { api: ChatApi }) {
  const [metas, setMetas] = useState<ThreadMeta[]>([]);
  const [active, setActive] = useState<ThreadWithUploads | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [effort, setEffort] = useState<Effort>("high");
  const [streaming, setStreaming] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmEvent | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Surfaces a failed initial load (threads/settings/runs) instead of silently
  // swallowing it — otherwise a broken /threads is indistinguishable from an
  // honestly-empty sidebar («Диалогов пока нет»).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runsById, setRunsById] = useState<Record<string, RunMeta>>({});
  const [runs, setRuns] = useState<RunMeta[]>([]); // newest-first, for the attach picker
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showLimits, setShowLimits] = useState(false);
  // Phones/tablets only: the thread list is collapsible (null = automatic: open while no chat
  // is selected, folded away once one is, so the conversation is what the user sees first).
  const [threadsOpen, setThreadsOpen] = useState<boolean | null>(null);
  const [searchParams] = useSearchParams();
  const liveBlocks = useRef<Block[]>([]);
  // Tool-trace entries collected during the live turn → attached to the assistant
  // message for the «Ход рассуждений» panel.
  const liveTrace = useRef<ToolTraceEntry[]>([]);
  // Aborts the in-flight SSE when the user presses «Стоп».
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void api
      .listThreads()
      .then(setMetas)
      .catch(() => {
        setMetas([]);
        setLoadError("Не удалось загрузить диалоги. Обновите страницу.");
      })
      .finally(() => setLoaded(true));
    void api
      .getSettings()
      .then((s) => setEffort(s.components?.chat_agent?.params.effort ?? "high"))
      .catch(() => setLoadError("Не удалось загрузить настройки чата. Откройте раздел «Настройки» и повторите."));
    // Run index → context bar metrics + the «Прикрепить анализ» picker.
    void api
      .listRuns()
      .then((rs) => {
        setRuns(rs);
        setRunsById(Object.fromEntries(rs.map((r) => [r.id, r])));
      })
      .catch(() => setLoadError("Не удалось загрузить список анализов. Обновите страницу."));
  }, [api]);

  const lastMsg = messages[messages.length - 1];
  const thinking = lastMsg?.role === "assistant" && lastMsg.blocks.length === 0;
  const runIds = contextRunIds(active?.context ?? null);
  const runMissing = Boolean((active as (Thread & { run_missing?: boolean }) | null)?.run_missing);
  // Sending is blocked until the chat is tied to an analysis (or staged files): otherwise the agent
  // would have to guess which analysis the user means and may answer about a different one.
  const stagedCount = (active?.uploads ?? []).length;
  const blockReason: string | null = !active
    ? null
    : runMissing
      ? "Анализ, к которому привязан этот чат, удалён. Прикрепите другой анализ или начните новый чат."
      : runIds.length === 0 && stagedCount === 0
        ? "Сначала выберите анализ — кнопка «Прикрепить анализ» ниже. Без него агент не знает, о каких данных речь."
        : null;
  // Server-classified XLSX attachments pinned to the open chat (массив/эталон).
  const staged = active?.uploads ?? [];

  const openThread = async (id: string) => {
    const t = await api.getThread(id);
    setActive(t);
    setMessages(t.messages);
  };

  // Refresh only the active thread's server state (context.runs + cleared uploads)
  // WITHOUT touching the local message stream — used after a confirmed run so the new
  // run shows up immediately without clobbering the just-streamed assistant comment.
  // Also re-pull the run index so the freshly-created analysis resolves to its NAME in
  // the context bar (not a raw run_id).
  const refreshActive = async (id: string) => {
    const [t, rs] = await Promise.all([api.getThread(id), api.listRuns().catch(() => null)]);
    setActive(t);
    setMetas((m) => m.map((x) => (x.id === t.id ? { ...x, context: t.context } : x)));
    if (rs) {
      setRuns(rs);
      setRunsById(Object.fromEntries(rs.map((r) => [r.id, r])));
    }
  };

  // Stage XLSX files onto the chat (creating a thread first if none is open), then
  // refetch the thread so the server-classified uploads + context stay in sync.
  const handleUpload = async (files: File[]) => {
    if (!files.length) return;
    let t: ThreadWithUploads | null = active;
    if (!t) {
      t = await api.createThread({ title: "Новый чат", category: "Анализ", context: null });
      setMetas((m) => [{ ...t! }, ...m]);
    }
    await api.uploadFiles(t.id, files);
    await openThread(t.id);
  };

  // × on an attachment chip: drop that staged file server-side and mirror the remaining
  // manifest locally (the removal persists with the thread, like the analysis detach).
  const removeUpload = async (stored: string) => {
    if (!active) return;
    try {
      const { uploads } = await api.removeUpload(active.id, stored);
      setActive((t) => (t ? { ...t, uploads } : t));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Не удалось убрать файл.");
    }
  };

  // Opened from «Спросить ИИ про результаты» (Результаты) → /chat?thread=<id>:
  // focus that freshly-bound thread instead of the demo state.
  const wantThread = searchParams.get("thread");
  useEffect(() => {
    if (wantThread) void openThread(wantThread);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantThread]);

  const newThread = async () => {
    const t = await api.createThread({ title: "Новый чат", category: "Анализ", context: null });
    setMetas((m) => [{ ...t }, ...m]);
    setActive(t);
    setMessages([]);
  };

  // Bind a run to the chat (creating a thread first if none is open), so the agent
  // answers by its data. Powers «Прикрепить анализ» + «Использовать текущий результат».
  // Appends to the context list (deduped) — a chat can pin several analyses.
  const bindRun = async (runId: string) => {
    let t = active;
    if (!t) {
      t = await api.createThread({ title: "Новый чат", category: "Анализ", context: null });
      setMetas((m) => [{ ...t! }, ...m]);
    }
    const next = Array.from(new Set([...contextRunIds(t.context), runId]));
    const updated = await api.patchThread(t.id, { context: { runs: next } });
    setActive(updated);
    setMessages(updated.messages);
    setMetas((m) => m.map((x) => (x.id === updated.id ? { ...x, context: updated.context } : x)));
  };

  const useCurrentRun = () => {
    if (runs.length) void bindRun(runs[0].id); // index is newest-first
  };

  const renameThread = async (id: string, title: string) => {
    const t = await api.patchThread(id, { title });
    setMetas((m) => m.map((x) => (x.id === id ? { ...x, title: t.title } : x)));
    setActive((a) => (a && a.id === id ? { ...a, title: t.title } : a));
  };

  // Drop a thread server-side, then prune it from the sidebar; if it was the open chat,
  // empty the message pane back to the honest «выберите чат» state.
  const removeThread = async (id: string) => {
    // The sidebar already asks for an explicit inline confirmation (trash → «Подтвердить
    // удаление»), so there is no second window.confirm here.
    await api.deleteThread(id);
    setMetas((m) => m.filter((x) => x.id !== id));
    if (active?.id === id) {
      setActive(null);
      setMessages([]);
    }
  };

  // Detach a single bound analysis from the chat by its run id; clearing the last one
  // empties the context entirely (detach → context null).
  const detachRun = async (runId: string) => {
    if (!active) return;
    const rest = contextRunIds(active.context).filter((x) => x !== runId);
    const t = await api.patchThread(
      active.id,
      rest.length ? { context: { runs: rest } } : { detach: true },
    );
    setActive(t);
    setMetas((m) => m.map((x) => (x.id === t.id ? { ...x, context: t.context } : x)));
  };

  // Mass cleanup of unused chats: «Новый чат» with no analysis attached (never given a question).
  const emptyIds = metas
    .filter((m) => m.title === "Новый чат" && !contextRunIds(m.context).length && m.id !== active?.id)
    .map((m) => m.id);
  const cleanupEmpty = async () => {
    for (const id of emptyIds) {
      try {
        await api.deleteThread(id);
      } catch {
        /* best-effort */
      }
    }
    setMetas((m) => m.filter((x) => !emptyIds.includes(x.id)));
  };

  const clearChat = async () => {
    liveBlocks.current = [];
    liveTrace.current = [];
    setMessages([]);
    if (active) {
      try {
        await api.patchThread(active.id, { clear_messages: true });
      } catch {
        /* best-effort: the local clear already happened */
      }
    }
  };

  // Fold a streamed assistant turn into the live blocks: tokens append/extend a trailing
  // text block; cards append a card block; both preserve Plan 1 order. Phase 2 adds the
  // transparency events: tool (→ trace panel), budget (→ note block), stopped (→ end turn).
  const applyEvent = (e: ChatEvent) => {
    if (e.event === "card") {
      liveBlocks.current = [...liveBlocks.current, { type: "card", card: e.card }];
    } else if (e.event === "token" || e.event === "error") {
      const blocks = [...liveBlocks.current];
      const last = blocks[blocks.length - 1];
      if (last && last.type === "text") {
        blocks[blocks.length - 1] = { type: "text", text: last.text + e.text };
      } else {
        blocks.push({ type: "text", text: e.text });
      }
      liveBlocks.current = blocks;
    } else if (e.event === "tool") {
      // Collect the tool-trace entry; it rides along on the assistant message below.
      liveTrace.current = [...liveTrace.current, { name: e.name, summary: e.summary }];
    } else if (e.event === "budget") {
      // Step budget exhausted — drop a short, distinct note block suggesting more effort.
      liveBlocks.current = [
        ...liveBlocks.current,
        { type: "text", text: "Использовано все шаги — попробуйте режим «Высокий»." },
      ];
    } else if (e.event === "stopped") {
      // The user stopped the turn: end the spinner; the partial answer stays as-is.
      setStreaming(false);
    } else if (e.event === "confirm") {
      setConfirm(e);
    }
    // status/done carry no block content here (status could feed a "печатает…" indicator).
    setMessages((prev) => replaceLiveAssistant(prev, liveBlocks.current, liveTrace.current));
  };

  const send = async (text: string) => {
    if (!active) return;
    const userMsg: ThreadMessage = { role: "user", text, ts: new Date().toISOString() };
    liveBlocks.current = [];
    liveTrace.current = [];
    setMessages((prev) => [...prev, userMsg, blankAssistant()]);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    await api.streamChat(
      { thread_id: active.id, message: text, effort, context: active.context },
      applyEvent,
      controller.signal,
    );
    abortRef.current = null;
    setStreaming(false);
    // The server titles a fresh chat after its first question — pull the new title into the sidebar.
    void api
      .listThreads()
      .then((ms) => {
        setMetas(ms);
        const me = ms.find((m) => m.id === active.id);
        if (me) setActive((a) => (a && a.id === me.id ? { ...a, title: me.title } : a));
      })
      .catch(() => undefined);
  };

  // «Стоп»: tell the server to cancel the running turn AND abort the in-flight SSE so the
  // browser stops reading immediately. The partial answer streamed so far stays on screen.
  const stopStreaming = () => {
    const id = active?.id;
    if (id) void api.stopChat(id);
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  };

  const resolveConfirm = async (approve: boolean) => {
    if (!active || !confirm) return;
    // A confirmed run_analysis appends a new run to context.runs and clears the staged
    // uploads server-side; remember to pull that in after the resumed turn streams.
    const refresh = approve && confirm.name === "run_analysis";
    const id = active.id;
    setConfirm(null);
    setStreaming(true);
    // Stream the resumed turn into the same assistant bubble (the SSE carries the
    // re-run comment / cancellation); a plain POST would drop it.
    await api.streamConfirm({ thread_id: id, approve }, applyEvent);
    setStreaming(false);
    if (refresh) await refreshActive(id);
  };

  return (
    <div className="h-full overflow-y-auto bg-muted/40 font-korpus lg:overflow-hidden">
      {/* Phones/tablets: one scrolling column (threads, then the conversation). From `lg`: two
          fixed-height columns where only the message window scrolls. */}
      <div className="mx-auto flex min-h-full max-w-[1400px] flex-col gap-4 p-4 sm:p-6 lg:h-full lg:min-h-0 lg:flex-row lg:gap-6">
        {/* LEFT COLUMN */}
        <div className="flex w-full shrink-0 flex-col gap-4 lg:h-full lg:min-h-0 lg:w-[348px]">
          <div className="shrink-0">
            <h1 className="text-2xl font-bold text-foreground">Чат с агентом</h1>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              Задавайте уточняющие вопросы по результатам анализа, ошибкам, группам и рекомендациям.
            </p>
          </div>

          <button
            type="button"
            onClick={() => setThreadsOpen(!(threadsOpen ?? !active))}
            aria-expanded={threadsOpen ?? !active}
            className="flex h-10 items-center justify-between rounded-korpus border border-border bg-card px-4 text-sm font-semibold text-foreground shadow-sm lg:hidden"
          >
            {(threadsOpen ?? !active) ? (
              <span className="text-xs font-medium text-korpus-blue">Скрыть список диалогов</span>
            ) : (
              <>
                <span>Диалоги{metas.length ? ` · ${metas.length}` : ""}</span>
                <span className="text-xs font-medium text-korpus-blue">Показать</span>
              </>
            )}
          </button>
          <div
            className={`h-80 min-h-0 flex-col lg:flex lg:h-auto lg:flex-1 ${
              (threadsOpen ?? !active) ? "flex" : "hidden"
            }`}
          >
          <ThreadSidebar
            threads={metas}
            activeId={active?.id ?? null}
            onSelect={(id) => {
              setThreadsOpen(false);
              return openThread(id);
            }}
            onNew={newThread}
            onRename={(id, title) => void renameThread(id, title)}
            onDelete={(id) => void removeThread(id)}
            emptyCount={emptyIds.length}
            onCleanupEmpty={() => void cleanupEmpty()}
          />
          </div>

          <div className="hidden shrink-0 items-start gap-3 rounded-korpus border border-border bg-card p-4 shadow-sm lg:flex">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-korpus-blue/10 text-korpus-blue">
              <Bot className="h-[18px] w-[18px]" strokeWidth={2} />
            </span>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Агент отвечает строго по данным привязанного анализа — критические вопросы, частые
              ошибки, рекомендации. Это помощник методиста, а не замена.
            </p>
          </div>
        </div>

        {/* MAIN COLUMN */}
        <div className="flex min-h-[40rem] min-w-0 flex-1 flex-col gap-4 lg:h-full lg:min-h-0">
          {/* Non-blocking banner for a failed initial load — keeps the empty states
              honest by distinguishing «API упал» from «диалогов действительно нет». */}
          {loadError && (
            <div
              role="alert"
              className="flex shrink-0 items-start gap-3 rounded-korpus border border-korpus-down/30 bg-korpus-down/5 px-4 py-3"
            >
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-korpus-down" strokeWidth={2} />
              <p className="min-w-0 flex-1 text-sm leading-relaxed text-korpus-down [overflow-wrap:anywhere]">{loadError}</p>
              <button
                type="button"
                onClick={() => setLoadError(null)}
                aria-label="Скрыть"
                className="shrink-0 rounded-full p-0.5 text-korpus-down/70 hover:bg-korpus-down/10 hover:text-korpus-down"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          <ContextBar
            context={active?.context ?? null}
            runsById={runsById}
            onDetach={detachRun}
            anyMissing={runMissing}
          />

          {/* Only the message window scrolls; the context bar above and the composer
              below stay pinned. Empty threads show an honest prompt, never fake data. */}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {messages.length > 0 ? (
              <MessageList messages={messages} />
            ) : (
              <ChatEmptyState
                active={active}
                bound={runIds.length > 0 && !runMissing}
                missing={runMissing}
                loaded={loaded}
                onPick={() => setPickerOpen(true)}
                onUseCurrent={runs.length ? useCurrentRun : undefined}
                onAsk={(q) => void send(q)}
              />
            )}
            {confirm && (
              <div className="mt-4 max-w-md">
                <ConfirmDialog request={confirm} onResolve={resolveConfirm} />
              </div>
            )}
          </div>

          {streaming && thinking && (
            <p role="status" className="shrink-0 text-center text-xs text-muted-foreground">
              Готовлю ответ… обычно это занимает до минуты.
            </p>
          )}

          {/* Stop control — visible only while a turn streams, so the methodologist can
              interrupt a slow model instead of staring at a frozen composer. */}
          {streaming && (
            <div className="flex shrink-0 justify-center">
              <button
                type="button"
                onClick={stopStreaming}
                className="flex h-9 items-center gap-2 rounded-korpus border border-korpus-down/40 bg-korpus-down/5 px-4 text-sm font-medium text-korpus-down transition-colors hover:bg-korpus-down/10"
              >
                <Square className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} />
                Стоп
              </button>
            </div>
          )}

          {/* Staged uploads pinned to the chat — sit just above the composer so the user
              sees what the agent will analyse, with a массив/эталон kind badge each. */}
          <StagedFiles files={staged} onRemove={(stored) => void removeUpload(stored)} />

          <Composer
            effort={effort}
            onEffortChange={setEffort}
            onSend={(m) => void send(m)}
            onAttachRun={() => setPickerOpen(true)}
            onUseCurrent={useCurrentRun}
            onClear={() => void clearChat()}
            onUploadFiles={(fs) => void handleUpload(fs)}
            disabled={streaming || !active}
            blockReason={blockReason}
          />

          <div className="shrink-0 text-[13px] text-muted-foreground">
            <p>
              {DISCLAIMER}.{" "}
              <button
                type="button"
                onClick={() => setShowLimits((v) => !v)}
                className="text-[13px] font-medium text-korpus-blue hover:underline"
              >
                {showLimits ? "Скрыть ограничения" : "Показать ограничения"}
              </button>
            </p>
            {showLimits && (
              <ul className="mt-2 list-disc space-y-1 pl-5 leading-relaxed">
                <li>Отвечает только по привязанному анализу — не знает данных за его пределами.</li>
                <li>Числа берёт из отчёта; формулировки и интерпретации могут быть приблизительными.</li>
                <li>Слабая статистика на малой выборке — выводы по группам с мало ответами осторожны.</li>
                <li>Это вспомогательный инструмент, а не замена решения методиста.</li>
              </ul>
            )}
          </div>
        </div>
      </div>

      {pickerOpen && (
        <RunPickerDialog
          runs={runs}
          onSelect={(id) => {
            setPickerOpen(false);
            void bindRun(id);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

/** «Прикрепить анализ» picker: a modal list of saved runs to bind to the chat. */
function RunPickerDialog({
  runs,
  onSelect,
  onClose,
}: {
  runs: RunMeta[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-korpus border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
          <h3 className="text-base font-semibold text-foreground">Прикрепить анализ</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="rounded-full p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {runs.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              Анализов пока нет. Запустите анализ на вкладке «Новый анализ».
            </p>
          ) : (
            runs.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => onSelect(r.id)}
                className="flex w-full items-center justify-between gap-3 rounded-korpus px-3 py-2.5 text-left transition-colors hover:bg-muted"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground" title={r.name || r.id}>
                    {r.name || r.id}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {courseLabel(r) ? `${courseLabel(r)} · ` : ""}
                    {r.summary?.total_users != null ? `${r.summary.total_users} польз. · ` : ""}
                    {formatDateTime(r.created_at)}
                  </span>
                </span>
                {r.summary?.avg_score != null && (
                  <span className="shrink-0 text-sm font-semibold text-korpus-blue">
                    {Math.round(r.summary.avg_score)}%
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function blankAssistant(): AssistantMessage {
  return { role: "assistant", blocks: [], ts: new Date().toISOString() };
}

/** Replace the trailing assistant message's blocks (and tool trace) with the live ones. */
function replaceLiveAssistant(
  prev: ThreadMessage[],
  blocks: Block[],
  trace: ToolTraceEntry[],
): ThreadMessage[] {
  const out = [...prev];
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === "assistant") {
      out[i] = {
        role: "assistant",
        blocks,
        ts: (out[i] as AssistantMessage).ts,
        ...(trace.length ? { tool_trace: trace } : {}),
      };
      break;
    }
  }
  return out;
}

/** Honest empty state for the message window — no fabricated demo conversation. Tells the
 *  user exactly what to do depending on whether a chat is open and bound to an analysis. */
const EXAMPLE_QUESTIONS = [
  "Какие вопросы самые трудные и почему?",
  "В какой группе результаты слабее всего?",
  "Что стоит исправить в первую очередь?",
];

function ChatEmptyState({
  active,
  bound,
  missing = false,
  loaded,
  onPick,
  onUseCurrent,
  onAsk,
}: {
  active: Thread | null;
  bound: boolean;
  /** The analysis the chat was bound to has been deleted. */
  missing?: boolean;
  loaded: boolean;
  onPick?: () => void;
  onUseCurrent?: () => void;
  onAsk?: (q: string) => void;
}) {
  if (!loaded && !active) return <div className="flex-1" />;

  let title: string;
  let body: string;
  if (!active) {
    title = "Выберите или создайте чат";
    body = "В списке диалогов выберите чат или создайте новый и привяжите к нему анализ, чтобы задавать вопросы по данным.";
  } else if (missing) {
    title = "Привязанный анализ удалён";
    body = "Прикрепите другой анализ кнопкой «Прикрепить анализ» ниже или откройте новый чат — по удалённым данным агент отвечать не будет.";
  } else if (!bound) {
    title = "Анализ не привязан";
    body = "Прикрепите анализ кнопкой «Прикрепить анализ» или «Использовать текущий результат» ниже — и агент будет отвечать строго по его данным.";
  } else {
    title = "Задайте первый вопрос";
    body = "Агент ответит по данным привязанного анализа: критические вопросы, частые ошибки, рекомендации.";
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-korpus-blue/10 text-korpus-blue">
        <MessageSquarePlus className="h-7 w-7" strokeWidth={1.75} />
      </span>
      <p className="mt-4 text-base font-semibold text-foreground">{title}</p>
      <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">{body}</p>
      {active && !bound && (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={onPick}
            className="h-10 rounded-korpus bg-korpus-blue px-4 text-sm font-semibold text-white hover:bg-korpus-blue-hover"
          >
            Выбрать анализ
          </button>
          {onUseCurrent && (
            <button
              type="button"
              onClick={onUseCurrent}
              className="h-10 rounded-korpus border border-border bg-card px-4 text-sm font-medium text-foreground hover:bg-muted"
            >
              Взять последний анализ
            </button>
          )}
        </div>
      )}
      {active && bound && onAsk && (
        <div className="mt-4 flex max-w-xl flex-wrap justify-center gap-2">
          {EXAMPLE_QUESTIONS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onAsk(q)}
              className="rounded-full border border-border bg-card px-3.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
            >
              {q}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
