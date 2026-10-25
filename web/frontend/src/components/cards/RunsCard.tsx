// web/frontend/src/components/cards/RunsCard.tsx
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import type { RunsCard as RunsCardData } from "@/types/chat";

function nd(v: string | number | null | undefined): string {
  return v === null || v === undefined ? "н/д" : String(v);
}

export function RunsCard({ card }: { card: RunsCardData }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{card.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y divide-border">
          {card.items.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="flex min-w-0 flex-col">
                <span className="font-medium">{nd(r.name)}</span>
                <span className="text-xs text-muted-foreground">курс {nd(r.course_id)}</span>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {/* Plan 1 list_runs sources `critical` from history._meta_from summary.critical —
                    a populated int for runs saved by the current engine; the null branch is for
                    legacy/hand-built indexes only (kept null-tolerant per D13). */}
                {r.critical !== null && r.critical > 0 && (
                  <span className="rounded-korpus bg-muted px-2 py-0.5 text-xs text-korpus-down">
                    крит.: {r.critical}
                  </span>
                )}
                <span className="font-semibold">
                  {r.avg_score === null ? "н/д" : `${r.avg_score}%`}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
