// web/frontend/src/components/cards/StatsCard.tsx
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StatsCard as StatsCardData } from "@/types/chat";

/** Embedded "Результаты по вопросу [N]" sub-card: a titled row of big values with
 *  small grey labels below. The first value is brand-blue (mockup highlight); any
 *  trailing unit (%, etc.) is rendered slightly smaller, as in the mockup. An optional
 *  `link` renders an «open the full report» action under the numbers. */
export function StatsCard({ card }: { card: StatsCardData }) {
  const metrics = Array.isArray(card.metrics) ? card.metrics : [];
  return (
    <div className="h-full rounded-korpus border border-border bg-muted/50 px-4 py-3">
      <div className="mb-3 text-sm font-semibold text-foreground">{card.title ?? ""}</div>
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        {metrics.map((m, i) => (
          <div key={i} className="min-w-[64px] max-w-full">
            <div
              className={cn(
                "break-words text-2xl font-bold leading-none",
                i === 0 ? "text-korpus-blue" : "text-foreground",
              )}
            >
              <Value text={String(m?.value ?? "")} />
            </div>
            <div className="mt-1.5 text-xs text-muted-foreground">{m?.label ?? ""}</div>
          </div>
        ))}
      </div>
      {card.link?.href ? (
        <Link
          to={card.link.href}
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-korpus-blue hover:underline"
        >
          {card.link.text || "Открыть отчёт"}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      ) : null}
    </div>
  );
}

/** Split a metric value into its leading number and a smaller trailing unit (e.g.
 *  "52%" → 52 + small %). Falls back to the raw text when there's no unit suffix. */
function Value({ text }: { text: string }) {
  const m = text.match(/^([\d.,\s]+)(\D.*)$/);
  if (!m) return <>{text}</>;
  return (
    <>
      {m[1].trim()}
      <span className="text-base font-semibold align-baseline">{m[2]}</span>
    </>
  );
}
