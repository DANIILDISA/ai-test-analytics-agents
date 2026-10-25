// web/frontend/src/api/chatStream.ts
// SSE client for POST /chat (Plan 3 + Phase 2 transparency). The decoder is split out
// (parseSseStream) so it is unit-testable without a network. Events match the wire
// contract exactly: status|tool|card|token|confirm|budget|stopped|done|error.
import { createParser, type EventSourceMessage } from "eventsource-parser";
import type { ChatEvent, Card, Effort, ThreadContext } from "@/types/chat";

function toEvent(name: string, data: string): ChatEvent | null {
  let payload: Record<string, unknown> = {};
  if (data && data !== "{}") {
    try {
      payload = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return { event: "error", text: "Получен некорректный ответ от сервера." };
    }
  }
  switch (name) {
    case "status":
      return { event: "status", text: String(payload.text ?? "") };
    case "card":
      return { event: "card", card: payload.card as Card };
    case "token":
      return { event: "token", text: String(payload.text ?? "") };
    case "confirm":
      return {
        event: "confirm",
        name: String(payload.name ?? ""),
        arguments: (payload.arguments as Record<string, unknown>) ?? {},
      };
    case "tool":
      return {
        event: "tool",
        name: String(payload.name ?? ""),
        summary: String(payload.summary ?? ""),
      };
    case "budget":
      return {
        event: "budget",
        used: Number(payload.used ?? 0),
        total: Number(payload.total ?? 0),
        hint: String(payload.hint ?? ""),
      };
    case "stopped":
      return { event: "stopped" };
    case "done":
      return { event: "done" };
    case "error":
      return { event: "error", text: String(payload.text ?? "Ошибка.") };
    default:
      return null;
  }
}

/** Parse an SSE byte stream, invoking `onEvent` per decoded ChatEvent. */
export async function parseSseStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (e: ChatEvent) => void,
): Promise<void> {
  const parser = createParser({
    onEvent(msg: EventSourceMessage) {
      // eventsource-parser v3.1.0: the SSE event-name field is `msg.event`
      // (undefined when not declared, unlike the browser EventSource which defaults to "message").
      // The local ChatEvent.event discriminant in types/chat.ts is unrelated and stays as-is.
      const ev = toEvent(msg.event ?? "message", msg.data);
      if (ev) onEvent(ev);
    },
  });
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value, { stream: true }));
  }
}

export interface ChatRequest {
  thread_id: string;
  message: string;
  effort: Effort;
  context: ThreadContext | null;
}

/** POST /chat and stream events. Network errors surface as a graceful error event. */
export async function streamChat(
  req: ChatRequest,
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(req),
      signal,
    });
  } catch {
    // The user pressed «Стоп» (AbortController) — a deliberate cancel, not a failure.
    if (signal?.aborted) return;
    onEvent({ event: "error", text: "Нет связи с сервером." });
    return;
  }
  if (!resp.ok || !resp.body) {
    onEvent({ event: "error", text: `Сервер вернул ошибку (${resp.status}).` });
    return;
  }
  try {
    await parseSseStream(resp.body, onEvent);
  } catch {
    if (signal?.aborted) return; // aborted mid-stream — stay silent
    onEvent({ event: "error", text: "Нет связи с сервером." });
  }
}

export interface ConfirmRequest {
  thread_id: string;
  approve: boolean;
}

/** POST /chat/confirm and stream the resumed turn. Same SSE contract as /chat:
 *  on approve the server runs the pending tool and streams the agent's comment;
 *  on decline it streams a short cancellation. (Was a plain JSON POST — which
 *  choked on the `event: ...` SSE frames and dropped the agent's reply.) */
export async function streamConfirm(
  req: ConfirmRequest,
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch("/chat/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(req),
      signal,
    });
  } catch {
    onEvent({ event: "error", text: "Нет связи с сервером." });
    return;
  }
  if (!resp.ok || !resp.body) {
    onEvent({ event: "error", text: `Сервер вернул ошибку (${resp.status}).` });
    return;
  }
  await parseSseStream(resp.body, onEvent);
}
