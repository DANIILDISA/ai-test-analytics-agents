// web/frontend/src/api/chatStream.test.ts
import { describe, it, expect, vi } from "vitest";
import { parseSseStream } from "@/api/chatStream";
import type { ChatEvent } from "@/types/chat";

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

const WIRE =
  'event: status\ndata: {"text":"Читаю анализ…"}\n\n' +
  'event: card\ndata: {"card":{"type":"stats","title":"Сводка","metrics":[{"label":"Средний балл","value":"70.3%"}]}}\n\n' +
  'event: token\ndata: {"text":"Самый "}\n\n' +
  'event: token\ndata: {"text":"сложный вопрос."}\n\n' +
  "event: done\ndata: {}\n\n";

describe("parseSseStream", () => {
  it("emits each event in order with parsed payloads", async () => {
    const seen: ChatEvent[] = [];
    await parseSseStream(streamOf(WIRE), (e) => seen.push(e));
    expect(seen.map((e) => e.event)).toEqual(["status", "card", "token", "token", "done"]);
    expect(seen[0]).toEqual({ event: "status", text: "Читаю анализ…" });
    if (seen[1].event === "card") expect(seen[1].card.type).toBe("stats");
    if (seen[2].event === "token") expect(seen[2].text).toBe("Самый ");
  });

  it("decodes a confirm event with name + arguments", async () => {
    const wire =
      'event: confirm\ndata: {"name":"run_analysis","arguments":{"params":{"max_llm_calls":20}}}\n\n';
    const cb = vi.fn();
    await parseSseStream(streamOf(wire), cb);
    expect(cb).toHaveBeenCalledWith({
      event: "confirm",
      name: "run_analysis",
      arguments: { params: { max_llm_calls: 20 } },
    });
  });

  it("decodes a graceful error event", async () => {
    const wire = 'event: error\ndata: {"text":"Не удалось обратиться к модели."}\n\n';
    const seen: ChatEvent[] = [];
    await parseSseStream(streamOf(wire), (e) => seen.push(e));
    expect(seen).toEqual([{ event: "error", text: "Не удалось обратиться к модели." }]);
  });

  it("decodes the Phase 2 transparency events: tool, budget, stopped", async () => {
    const wire =
      'event: tool\ndata: {"name":"read_analysis","summary":"Прочитал анализ r1."}\n\n' +
      'event: budget\ndata: {"used":6,"total":6,"hint":"Поднимите глубину."}\n\n' +
      "event: stopped\ndata: {}\n\n";
    const seen: ChatEvent[] = [];
    await parseSseStream(streamOf(wire), (e) => seen.push(e));
    expect(seen).toEqual([
      { event: "tool", name: "read_analysis", summary: "Прочитал анализ r1." },
      { event: "budget", used: 6, total: 6, hint: "Поднимите глубину." },
      { event: "stopped" },
    ]);
  });
});
