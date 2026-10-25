// web/frontend/src/components/chat/MessageList.tsx
import { Bot, CheckCheck, Copy, Download } from "lucide-react";
import { BlockList } from "@/components/chat/BlockList";
import { isCardBlock } from "@/types/chat";
import type { Block, ReportCard, ThreadMessage, ToolTraceEntry } from "@/types/chat";

function clock(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export function MessageList({ messages }: { messages: ThreadMessage[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {messages.map((m, i) =>
        m.role === "user" ? (
          <div key={i} className="flex min-w-0 flex-col items-end">
            <div className="max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-korpus-blue/10 px-4 py-2.5 text-sm leading-relaxed text-foreground [overflow-wrap:anywhere] sm:max-w-[78%]">
              {m.text}
            </div>
            <div className="mt-1 flex items-center gap-1 pr-1 text-[11px] text-muted-foreground">
              <span>{clock(m.ts)}</span>
              <CheckCheck className="h-3.5 w-3.5 text-korpus-blue" />
            </div>
          </div>
        ) : (
          <div key={i} className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-korpus-blue/10 text-korpus-blue">
              <Bot className="h-[18px] w-[18px]" strokeWidth={2} />
            </span>
            <div className="min-w-0 max-w-[calc(100%-3rem)] sm:max-w-[82%]">
              <div className="rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-3 shadow-sm [overflow-wrap:anywhere]">
                <BlockList blocks={blocksWithoutReports(m.blocks)} />
                {reportCardsOf(m.blocks).map((c, j) => (
                  <ReportView key={j} card={c} />
                ))}
                {m.tool_trace && m.tool_trace.length > 0 && (
                  <ToolTracePanel trace={m.tool_trace} />
                )}
              </div>
              {m.ts && (
                <div className="mt-1 pl-1 text-[11px] text-muted-foreground">{clock(m.ts)}</div>
              )}
            </div>
          </div>
        ),
      )}
    </div>
  );
}

/** Report cards (Phase 6 «Отчёт» deliverable) carried in an assistant turn's blocks.
 *  MessageList renders these itself — not via BlockList/CardView — so it can add the
 *  copy/download chrome and the scrollable preformatted box. */
function reportCardsOf(blocks: Block[]): ReportCard[] {
  return blocks
    .filter(isCardBlock)
    .map((b) => b.card)
    .filter((c): c is ReportCard => c.type === "report");
}

/** Every block except report cards, in original order, for the normal BlockList path. */
function blocksWithoutReports(blocks: Block[]): Block[] {
  return blocks.filter((b) => !(isCardBlock(b) && b.card.type === "report"));
}

/** The saved «Отчёт» deliverable: the full report text shown faithfully as preformatted
 *  monospace text in a scrollable box (NO markdown library), plus «Копировать» (clipboard)
 *  and «Скачать .md» (client-side Blob download — no backend endpoint) controls. */
function ReportView({ card }: { card: ReportCard }) {
  function copy() {
    // Graceful no-op where the Clipboard API is unavailable (insecure/older contexts).
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (clip?.writeText) void clip.writeText(card.markdown);
  }
  function download() {
    const blob = new Blob([card.markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "отчёт.md";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="mt-2.5 overflow-hidden rounded-korpus border border-border bg-muted/30">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <span className="min-w-0 truncate text-sm font-semibold text-foreground">
          {card.title}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1 rounded-korpus border border-border bg-card px-2 py-1 text-xs font-medium text-foreground hover:bg-muted"
          >
            <Copy className="h-3.5 w-3.5" strokeWidth={2} />
            Копировать
          </button>
          <button
            type="button"
            onClick={download}
            className="inline-flex items-center gap-1 rounded-korpus border border-border bg-card px-2 py-1 text-xs font-medium text-foreground hover:bg-muted"
          >
            <Download className="h-3.5 w-3.5" strokeWidth={2} />
            Скачать .md
          </button>
        </div>
      </div>
      <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground">
        {card.markdown}
      </pre>
    </div>
  );
}

/** Collapsible «Ход рассуждений» — shown ONLY when the agent actually used its tools (the
 *  quick single-call answers carry no trace). Collapsed by default (native <details>); each
 *  step is a plain-Russian line — internal tool names are not exposed. */
function ToolTracePanel({ trace }: { trace: ToolTraceEntry[] }) {
  return (
    <details className="mt-2.5 rounded-korpus border border-border/60 bg-muted/30 px-3 py-2 text-xs">
      <summary className="cursor-pointer select-none font-medium text-muted-foreground">
        Ход рассуждений
      </summary>
      <ul className="mt-2 flex flex-col gap-1.5">
        {trace.map((t, j) => (
          <li key={j} className="leading-relaxed text-muted-foreground">
            {stepText(t.summary)}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** «query_stats: сводка прогона X» → «Сводка прогона X»: drop the leading internal tool name. */
function stepText(summary: string | undefined): string {
  const text = String(summary ?? "").replace(/^[a-z_]+:\s*/, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
