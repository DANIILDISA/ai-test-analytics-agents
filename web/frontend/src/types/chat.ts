// web/frontend/src/types/chat.ts
// Frontend mirror of the Plan 1 agent output contract (agents/chat_agent/tools.py +
// loop.py) and the Plan 3 wire contract (FastAPI SSE/REST). Field names match the
// Python emitters byte-for-byte; do not rename.

/** Card tags exactly as tools.py builds them. */
export const CARD_TYPES = ["stats", "list", "runs", "compare"] as const;
export type CardType = (typeof CARD_TYPES)[number];

/** Effort values exactly as effort.py keys / the SSE request body use. */
export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

// --- Card payloads (Plan 1 tools.py) ---
export interface Metric { label: string; value: string }
export interface StatsCard {
  type: "stats";
  title: string;
  metrics: Metric[];
  /** Optional «open the full report» link (e.g. /results?run=<id>). */
  link?: { href: string; text: string };
}

export interface ListItem { text: string; value: string }
export interface ListCard { type: "list"; title: string; items: ListItem[] }

export interface RunItem {
  id: string;
  name: string | null;
  course_id: string | null;
  avg_score: number | null;
  critical: number | null;
}
export interface RunsCard { type: "runs"; title: string; items: RunItem[] }

export interface CompareRow {
  label: string;
  a: number | null;
  b: number | null;
  delta: number;
}
export interface CompareCard {
  type: "compare";
  title: string;
  rows: CompareRow[];
  a_label?: string; // analysis A name (column header); falls back to "A"
  b_label?: string; // analysis B name (column header); falls back to "B"
}

/** A saved "Отчёт" deliverable (Phase 6 generate_report): the full report text the
 *  methodologist can take away. `markdown` is the raw report body, shown as faithful
 *  preformatted text (no markdown parsing). Not in CARD_TYPES — it never routes through
 *  CardView; MessageList renders it directly with copy/download controls. */
export interface ReportCard { type: "report"; title: string; markdown: string }

export type Card = StatsCard | ListCard | RunsCard | CompareCard | ReportCard;

// --- Blocks (Plan 1 loop.py output: ordered [text|card]) ---
export interface TextBlock { type: "text"; text: string }
export interface CardBlock { type: "card"; card: Card }
export type Block = TextBlock | CardBlock;

export function isTextBlock(b: Block): b is TextBlock {
  return b.type === "text";
}
export function isCardBlock(b: Block): b is CardBlock {
  return b.type === "card";
}

// --- SSE events (Plan 3 + Phase 2 transparency: status|tool|card|token|confirm|budget|stopped|done|error) ---
export interface StatusEvent { event: "status"; text: string }
export interface CardEvent { event: "card"; card: Card }
export interface TokenEvent { event: "token"; text: string }
export interface ConfirmEvent {
  event: "confirm";
  name: string; // tool name, e.g. "run_analysis"
  arguments: Record<string, unknown>; // proposed params
}
/** One tool-trace entry — emitted right after each tool runs, before the final prose. */
export interface ToolEvent { event: "tool"; name: string; summary: string }
/** Step budget exhausted; `hint` suggests raising effort. */
export interface BudgetEvent { event: "budget"; used: number; total: number; hint: string }
/** The user stopped the turn (turn ends without a `done`). */
export interface StoppedEvent { event: "stopped" }
export interface DoneEvent { event: "done" }
export interface ErrorEvent { event: "error"; text: string } // graceful Russian message
export type ChatEvent =
  | StatusEvent
  | CardEvent
  | TokenEvent
  | ConfirmEvent
  | ToolEvent
  | BudgetEvent
  | StoppedEvent
  | DoneEvent
  | ErrorEvent;

/** One tool-trace entry as persisted on an assistant message + surfaced in the
 *  «Ход рассуждений» panel (mirrors the backend `tool_trace` list). */
export interface ToolTraceEntry { name: string; summary: string }

// --- Thread/message REST shapes (Plan 1 threads.py persisted via Plan 3 REST) ---
export type ThreadCategory = "Анализ" | "Сравнение" | "Курс";

export interface ThreadContext {
  runs?: string[];
  run_id?: string;
  compare?: [string, string];
  course?: string;
}

/**
 * Normalize a thread's context to the list of analysis run ids it pins.
 * Mirrors the backend precedence (threads.py): falsy → []; `runs` →
 * truthy entries of `runs`; legacy `compare` → both ids; legacy `run_id` →
 * the single id; otherwise [].
 */
export function contextRunIds(context: ThreadContext | null): string[] {
  if (!context) return [];
  if (Array.isArray(context.runs)) return context.runs.filter(Boolean);
  if (Array.isArray(context.compare)) return [...context.compare];
  if (context.run_id) return [context.run_id];
  return [];
}

/** Index entry (threads._meta_from). */
export interface ThreadMeta {
  id: string;
  title: string;
  category: ThreadCategory;
  context: ThreadContext | null;
  created_at: string;
  updated_at: string;
  /** True when the analysis this chat was bound to has been deleted (set by the server). */
  run_missing?: boolean;
}

export interface UserMessage { role: "user"; text: string; ts: string }
export interface AssistantMessage {
  role: "assistant";
  blocks: Block[];
  tool_trace?: ToolTraceEntry[];
  ts: string;
}
export type ThreadMessage = UserMessage | AssistantMessage;

/** Full thread file (threads.new_thread + messages). */
export interface Thread extends ThreadMeta {
  messages: ThreadMessage[];
}

// --- Settings (Plan 3 GET /settings = core.settings.ui_view) ---
// Wire shape is `{components: {analysis, insight, chat_agent}, keys: {...}}`; the chat
// screen reads only components.chat_agent (default effort). Field names match ui_view.
export interface ChatComponentSettings {
  provider: string;
  model: string;
  params: { effort?: Effort; max_tokens?: number; temperature?: number };
}

/** Per-key status from core.settings.ui_view (never the raw secret). */
export interface KeyStatus {
  set: boolean;
  source: "ui" | "env" | "none";
  preview: string;
}

export interface Settings {
  components: { chat_agent: ChatComponentSettings; [k: string]: ChatComponentSettings };
  keys?: Record<string, KeyStatus>;
}
