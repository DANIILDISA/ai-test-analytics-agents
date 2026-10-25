// web/frontend/src/api/client.ts
// REST wrappers over the Plan 3 endpoints. Streaming chat lives in chatStream.ts;
// this file is request/response JSON only.
import type { ThreadMeta, Thread, ThreadCategory, ThreadContext, Settings } from "@/types/chat";

/** Never show raw technical text (HTTP codes, JSON parse errors) to the methodologist. */
export const LOAD_FAILED = "Не удалось загрузить данные. Проверьте, что программа запущена, и повторите.";

export const REQUEST_FAILED = "Не удалось выполнить действие. Проверьте, что программа запущена, и повторите.";

async function getJson<T>(url: string): Promise<T> {
  let resp: Response;
  try {
    // `no-store`: «/settings» is both an SPA page and a JSON endpoint on one URL — a cached
    // HTML answer must never be reused for the JSON call.
    resp = await fetch(url, { method: "GET", headers: { Accept: "application/json" }, cache: "no-store" });
  } catch {
    throw new Error(LOAD_FAILED);
  }
  if (!resp.ok) throw new Error(LOAD_FAILED);
  try {
    return (await resp.json()) as T;
  } catch {
    throw new Error(LOAD_FAILED);
  }
}

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const resp = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(REQUEST_FAILED);
  return (await resp.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(REQUEST_FAILED);
  return (await resp.json()) as T;
}

async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const resp = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(REQUEST_FAILED);
  return (await resp.json()) as T;
}

/** Pull the Russian `detail` out of a FastAPI HTTPException body, falling back to a
 *  generic message. The non-chat endpoints surface config/key/analysis errors as
 *  `{ detail: "..." }` (web/api.py), so we prefer that text for the UI. */
async function readError(resp: Response, fallback: string): Promise<string> {
  try {
    const body = (await resp.json()) as { detail?: unknown };
    if (typeof body?.detail === "string" && body.detail.trim()) return body.detail;
  } catch {
    /* non-JSON / empty body — use the fallback below */
  }
  return fallback;
}

/** POST multipart/form-data (FormData sets its own Content-Type with the boundary). */
async function postForm<T>(
  url: string,
  form: FormData,
  fallbackError: string,
  signal?: AbortSignal,
): Promise<T> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: form,
    signal,
  });
  if (!resp.ok) throw new Error(await readError(resp, fallbackError));
  return (await resp.json()) as T;
}

/** DELETE with no response body (the backend returns 204/JSON ack). Throws the
 *  Russian `detail` from a FastAPI HTTPException on a non-ok status. */
async function delJson(url: string, fallbackError: string): Promise<void> {
  const resp = await fetch(url, { method: "DELETE", headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(await readError(resp, fallbackError));
}

export function listThreads(): Promise<ThreadMeta[]> {
  return getJson<ThreadMeta[]>("/threads");
}

export function getThread(id: string): Promise<Thread> {
  return getJson<Thread>(`/threads/${id}`);
}

export interface NewThreadRequest {
  title: string;
  category: ThreadCategory;
  context: ThreadContext | null;
}
export function createThread(req: NewThreadRequest): Promise<Thread> {
  return postJson<Thread>("/threads", req);
}

/** Partial PATCH /threads/:id — bind/clear an analysis or rename. `clear_messages`
 *  wipes the thread's history (the «Очистить чат» button). Returns the updated thread. */
export interface ThreadPatch {
  title?: string;
  category?: ThreadCategory;
  context?: ThreadContext | null;
  clear_messages?: boolean;
  detach?: boolean; // clear the bound analysis/comparison (context → null)
}
export function patchThread(id: string, patch: ThreadPatch): Promise<Thread> {
  return patchJson<Thread>(`/threads/${id}`, patch);
}

/** DELETE /threads/:id — drop a thread (and its bound chat history) server-side. */
export function deleteThread(id: string): Promise<void> {
  return delJson(`/threads/${id}`, "Не удалось удалить тред.");
}

/** POST /chat/:id/stop — signal the server to cancel the in-flight streaming turn
 *  (the «Стоп» button). Best-effort: the server acks with no meaningful body and a
 *  transport error here must not surface, since the client has already aborted the SSE. */
export async function stopChat(id: string): Promise<void> {
  try {
    await fetch(`/chat/${id}/stop`, { method: "POST", headers: { Accept: "application/json" } });
  } catch {
    /* best-effort: the local AbortController already stopped the stream */
  }
}

/** One stored attachment from POST /chat/:id/uploads — `stored` is the server-side
 *  filename, `kind` flags whether it was classified as the массив (user answers) or
 *  the эталон (reference). */
export interface ChatUpload {
  filename: string;
  stored: string;
  kind: "massiv" | "etalon";
  size: number;
}

/** POST /chat/:id/uploads as multipart (each file under the "files" key) and return
 *  the stored-attachment manifest. Throws the Russian `detail` on a non-ok status. */
export function uploadChatFiles(threadId: string, files: File[]): Promise<{ uploads: ChatUpload[] }> {
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  return postForm<{ uploads: ChatUpload[] }>(
    `/chat/${threadId}/uploads`,
    form,
    "Не удалось загрузить файлы.",
  );
}

/** Defaults of a new analysis (Настройки → Параметры анализа), resolved by the backend:
 *  UI overlay > config.yaml > built-in. `aspects` are insight block keys. */
export interface AnalysisDefaults {
  model_group: string; // "foreign" | "russian"
  model?: string; // model id of that group, e.g. "GigaChat-3-Ultra" (display only)
  provider?: string;
  deep: boolean; // «Глубокий анализ с ИИ»
  max_llm_calls: number;
  aspects: string[]; // subset of why_failed | diagnosis | anomalies | recommendations
}

/** Built-in fallback used until /settings answers (and when it fails). */
export const FALLBACK_ANALYSIS_DEFAULTS: AnalysisDefaults = {
  model_group: "russian",
  model: "GigaChat-3-Ultra",
  provider: "gigachat",
  deep: true,
  max_llm_calls: 500,
  aspects: ["why_failed", "diagnosis", "anomalies", "recommendations"],
};

export type SettingsWithDefaults = Settings & { analysis_defaults?: AnalysisDefaults };

/** DELETE /chat/:id/uploads/:stored — remove ONE staged attachment (the × on its chip).
 *  Returns the remaining manifest; the removal is persisted per thread server-side. */
export async function removeChatUpload(
  threadId: string,
  stored: string,
): Promise<{ uploads: ChatUpload[] }> {
  const resp = await fetch(`/chat/${threadId}/uploads/${encodeURIComponent(stored)}`, {
    method: "DELETE",
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(await readError(resp, "Не удалось убрать файл."));
  return (await resp.json()) as { uploads: ChatUpload[] };
}

export function getSettings(): Promise<SettingsWithDefaults> {
  return getJson<SettingsWithDefaults>("/settings");
}

/** The saved defaults of a new analysis; never throws (falls back to the built-in ones). */
export async function getAnalysisDefaults(): Promise<AnalysisDefaults> {
  try {
    const s = await getSettings();
    return { ...FALLBACK_ANALYSIS_DEFAULTS, ...(s.analysis_defaults ?? {}) };
  } catch {
    return FALLBACK_ANALYSIS_DEFAULTS;
  }
}

/** Partial PUT /settings body — send only changed fields (web/api.py deep-merges).
 *  `components` carries per-component {provider?, model?, params?}; `keys` maps an
 *  ENV name to the raw override string (empty string clears it on the server side). */
export interface SettingsPatch {
  components?: Record<string, { provider?: string; model?: string; params?: Record<string, unknown> }>;
  keys?: Record<string, string>;
  analysis_defaults?: Partial<Omit<AnalysisDefaults, "model" | "provider">>;
}

/** PUT /settings with only the changed fields; returns the refreshed ui_view. */
export function putSettings(patch: SettingsPatch): Promise<SettingsWithDefaults> {
  return putJson<SettingsWithDefaults>("/settings", {
    components: patch.components ?? {},
    keys: patch.keys ?? {},
    analysis_defaults: patch.analysis_defaults ?? {},
  });
}

// --- Report downloads (Word / PDF / Excel) ----------------------------------------

export type ReportKind = "docx" | "pdf" | "xlsx";

export const REPORT_LABEL: Record<ReportKind, string> = { docx: "Word", pdf: "PDF", xlsx: "Excel" };

/** Excel in the history/results rows = summary + per-question numbers (not the anomaly/student sheets). */
const REPORT_QUERY: Partial<Record<ReportKind, string>> = { xlsx: "?sections=summary,questions" };

/** «filename*=UTF-8''…» (or plain filename=) of a Content-Disposition header, if any. */
function dispositionName(header: string | null): string | null {
  if (!header) return null;
  const star = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through to the plain filename */
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : null;
}

/** Download a report of a saved run through fetch, so a failure (no browser for the PDF, run
 *  gone) is shown as a Russian message instead of a broken tab. When the server cannot print the
 *  PDF it returns printable HTML; that is opened in a new tab for Ctrl+P and `"html"` is returned. */
export async function downloadReport(runId: string, kind: ReportKind): Promise<"file" | "html"> {
  let resp: Response;
  try {
    resp = await fetch(`/download/${encodeURIComponent(runId)}.${kind}${REPORT_QUERY[kind] ?? ""}`);
  } catch {
    throw new Error(`Не удалось скачать ${REPORT_LABEL[kind]}. Проверьте, что программа запущена, и повторите.`);
  }
  if (!resp.ok) throw new Error(`Не удалось сформировать ${REPORT_LABEL[kind]}. Попробуйте ещё раз.`);
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  if (resp.headers.get("X-Report-Fallback") === "html") {
    window.open(url, "_blank");
    return "html";
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = dispositionName(resp.headers.get("Content-Disposition")) ?? `report.${kind}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "file";
}


// --- Analysis tabs (Новый анализ / История / Сравнение) --------------------------
// Wire contract = web/api.py: POST /analyze (multipart) → result dict (incl. run_id);
// GET /runs → run-meta index; GET /runs/:id → full result; POST /compare → diff.

/** The runner result dict (web/service.run_analysis). Free-form on the analysis side;
 *  we only need `run_id` here to navigate, so the rest is left open for the Results
 *  screen to read. `error` is set when a per-course analysis failed. */
export interface AnalysisResult {
  run_id?: string;
  course_id?: string;
  error?: string;
  warnings?: string[];
  answer?: unknown;
  time?: unknown;
  insights?: unknown;
  [k: string]: unknown;
}

/** Index entry from GET /runs (core.history._meta_from). */
export interface RunMeta {
  id: string;
  created_at: string;
  name: string;
  course_id: string | null;
  model_group: string;
  mode: string;
  /** Group labels of a multi-group run («Группа 1», …). Absent on older runs. */
  groups?: string[];
  /** How many uploaded files could not be used (unreadable / unsupported). Absent on older runs. */
  skipped_files?: number;
  summary: {
    total_users: number | null;
    total_questions: number | null;
    avg_score: number | null;
    critical: number | null;
    real_attempts?: number | null;
    abandoned?: number | null;
  };
}

/** Inputs collected by the «Новый анализ» screen and mapped onto the /analyze form. */
export interface AnalyzeRequest {
  /** Required user-answers XLSX files — one per group; several → one run with a
   *  per-group breakdown (web/service.run_analysis). At least one is required. */
  answers: File[];
  /** Optional reference (эталон) XLSX, shared across all groups. */
  reference?: File | null;
  /** Provider group: "foreign" (OpenRouter) | "russian" (GigaChat). */
  modelGroup: string;
  /** Runner mode: "all" | "answer" | "time". */
  mode: string;
  /** 0 = free/code-only; >0 enables per-answer deep analysis. */
  maxLlmCalls: number;
  /** Master toggle for the AI commentary (Agent 4). */
  useInsights: boolean;
  /** Subset of insight block keys: diagnosis|why_failed|recommendations|anomalies. */
  insightBlocks: string[];
  /** Free-text insight request. */
  insightNote?: string;
  /** Course label saved with the run. */
  courseId?: string;
  /** Lets the screen cancel the wait («Отмена» during a long analysis). */
  signal?: AbortSignal;
}

/** POST /analyze as multipart and return the result dict (with run_id on success).
 *  Throws an Error carrying the Russian `detail` on a 4xx (config/key/analysis error). */
export function analyzeRun(req: AnalyzeRequest): Promise<AnalysisResult> {
  const form = new FormData();
  // One "answers" entry per group file; FastAPI binds them into list[UploadFile].
  for (const f of req.answers) form.append("answers", f, f.name);
  if (req.reference) form.append("reference", req.reference, req.reference.name);
  form.append("model_group", req.modelGroup);
  form.append("mode", req.mode);
  form.append("max_llm_calls", String(req.maxLlmCalls));
  form.append("course_id", req.courseId ?? "анализ");
  form.append("use_insights", req.useInsights ? "true" : "false");
  for (const b of req.insightBlocks) form.append("insight_blocks", b);
  form.append("insight_note", req.insightNote ?? "");
  return postForm<AnalysisResult>("/analyze", form, "Не удалось выполнить анализ.", req.signal);
}

export function listRuns(): Promise<RunMeta[]> {
  return getJson<RunMeta[]>("/runs");
}

/** POST /runs/delete — remove analyses; `deleteChats` also removes the chats bound to them. */
export async function deleteRuns(ids: string[], deleteChats = false): Promise<void> {
  const resp = await fetch("/runs/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ids, delete_chats: deleteChats }),
  });
  if (!resp.ok) throw new Error(await readError(resp, "Не удалось удалить анализы."));
}

export function getRun(id: string): Promise<AnalysisResult> {
  return getJson<AnalysisResult>(`/runs/${id}`);
}

export function compareRuns(runIdA: string, runIdB: string): Promise<Record<string, unknown>> {
  return postJson<Record<string, unknown>>("/compare", { run_id_a: runIdA, run_id_b: runIdB });
}

/** PATCH /runs/:id — give an analysis a new display name. */
export async function renameRun(id: string, name: string): Promise<void> {
  const resp = await fetch(`/runs/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!resp.ok) throw new Error(await readError(resp, "Не удалось переименовать анализ."));
}
