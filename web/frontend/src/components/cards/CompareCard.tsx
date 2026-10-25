// web/frontend/src/components/cards/CompareCard.tsx
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { CompareCard as CompareCardData } from "@/types/chat";

function nd(v: number | null): string {
  return v === null ? "н/д" : String(v);
}

function signed(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
}

export function CompareCard({ card }: { card: CompareCardData }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{card.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="w-[34%] py-1 pr-2 font-normal">Показатель</th>
              <th className="truncate py-1 pr-2 font-normal" title={card.a_label}>{card.a_label ?? "A"}</th>
              <th className="truncate py-1 pr-2 font-normal" title={card.b_label}>{card.b_label ?? "B"}</th>
              <th className="w-12 py-1 font-normal">Δ</th>
            </tr>
          </thead>
          <tbody>
            {card.rows.map((row, i) => (
              <tr key={i} className="border-t border-border">
                <td className="py-1.5 pr-2">{row.label}</td>
                <td className="py-1.5">{nd(row.a)}</td>
                <td className="py-1.5">{nd(row.b)}</td>
                <td
                  className={cn(
                    "py-1.5 font-semibold",
                    row.delta > 0 && "text-korpus-up",
                    row.delta < 0 && "text-korpus-down",
                  )}
                >
                  {signed(row.delta)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
