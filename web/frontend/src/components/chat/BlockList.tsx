// web/frontend/src/components/chat/BlockList.tsx
import type { ReactNode } from "react";
import { CardView } from "@/components/cards/CardView";
import { isCardBlock } from "@/types/chat";
import type { Block } from "@/types/chat";
import { humanizeAgentText } from "@/lib/agentText";

/** Render one assistant message's ordered [text|card] blocks (Plan 1 D12).
 *  Runs of adjacent `stats` cards are laid out two-up (mockup's "Результаты по
 *  вопросу [3]" + "Сравнение с группой" row); other blocks stay full-width. */
export function BlockList({ blocks }: { blocks: Block[] }) {
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed text-foreground">
      {groupStatsRuns(blocks).map((group, gi) =>
        group.length > 1 ? (
          <div key={gi} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {group.map((b, i) =>
              isCardBlock(b) ? <CardView key={i} card={b.card} /> : null,
            )}
          </div>
        ) : isCardBlock(group[0]) ? (
          <CardView key={gi} card={group[0].card} />
        ) : (
          <Prose key={gi} text={(group[0] as { type: "text"; text: string }).text} />
        ),
      )}
    </div>
  );
}

/** Collapse runs of consecutive `stats` card blocks into grouped arrays; every other
 *  block becomes a singleton group, preserving Plan 1 order. */
function groupStatsRuns(blocks: Block[]): Block[][] {
  const out: Block[][] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    const isStats = isCardBlock(b) && b.card.type === "stats";
    const prevIsStats = prev && isCardBlock(prev[0]) && prev[0].card.type === "stats";
    if (isStats && prevIsStats) prev.push(b);
    else out.push([b]);
  }
  return out;
}

/** Lightweight markdown-ish renderer: groups runs of "- "/"• "/"* " lines into a
 *  bullet list and renders the rest as paragraphs (matches the mockup's prose). */
function Prose({ text: rawText }: { text: string }) {
  const lines = humanizeAgentText(rawText).split("\n");
  const nodes: ReactNode[] = [];
  let bullets: string[] = [];
  let para: string[] = [];

  const flushPara = (key: string) => {
    if (para.length === 0) return;
    nodes.push(
      <p key={key} className="whitespace-pre-wrap">
        {para.join("\n")}
      </p>,
    );
    para = [];
  };
  const flushBullets = (key: string) => {
    if (bullets.length === 0) return;
    nodes.push(
      <ul key={key} className="ml-1 flex flex-col gap-1.5">
        {bullets.map((bl, j) => (
          <li key={j} className="flex gap-2">
            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-korpus-blue" />
            <span>{bl}</span>
          </li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  lines.forEach((line, idx) => {
    const m = line.match(/^\s*[-•*]\s+(.*)$/);
    if (m) {
      flushPara(`p${idx}`);
      bullets.push(m[1]);
    } else {
      flushBullets(`b${idx}`);
      if (line.trim() !== "") para.push(line);
    }
  });
  flushPara("p-end");
  flushBullets("b-end");

  return <>{nodes}</>;
}
