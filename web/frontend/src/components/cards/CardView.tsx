// web/frontend/src/components/cards/CardView.tsx
import { StatsCard } from "@/components/cards/StatsCard";
import { ListCard } from "@/components/cards/ListCard";
import { RunsCard } from "@/components/cards/RunsCard";
import { CompareCard } from "@/components/cards/CompareCard";
import type { Card } from "@/types/chat";

/** Single source of the card.type → component mapping. */
export function CardView({ card }: { card: Card }) {
  switch (card.type) {
    case "stats":
      return <StatsCard card={card} />;
    case "list":
      return <ListCard card={card} />;
    case "runs":
      return <RunsCard card={card} />;
    case "compare":
      return <CompareCard card={card} />;
    case "report":
      // «report» cards are the chat report deliverable; MessageList renders them itself
      // (scrollable text + Копировать/Скачать) and never routes them through CardView.
      return null;
    default: {
      // Exhaustiveness guard: a new card.type must be added above.
      const _never: never = card;
      return _never;
    }
  }
}
