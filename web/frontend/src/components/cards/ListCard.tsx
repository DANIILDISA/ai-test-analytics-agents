// web/frontend/src/components/cards/ListCard.tsx
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import type { ListCard as ListCardData } from "@/types/chat";

export function ListCard({ card }: { card: ListCardData }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{card.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y divide-border">
          {card.items.map((it, i) => (
            <li key={i} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0">{it.text}</span>
              <span className="shrink-0 font-semibold text-foreground">{it.value}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
