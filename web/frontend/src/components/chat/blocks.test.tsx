// web/frontend/src/components/chat/blocks.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CardView } from "@/components/cards/CardView";
import { BlockList } from "@/components/chat/BlockList";
import type { Block } from "@/types/chat";

describe("CardView", () => {
  it("dispatches each card.type to its renderer", () => {
    const { rerender } = render(
      <CardView card={{ type: "stats", title: "S", metrics: [{ label: "L", value: "1" }] }} />,
    );
    expect(screen.getByText("S")).toBeInTheDocument();
    rerender(<CardView card={{ type: "list", title: "L2", items: [{ text: "x", value: "y" }] }} />);
    expect(screen.getByText("L2")).toBeInTheDocument();
    rerender(
      <CardView card={{ type: "runs", title: "R", items: [{ id: "1", name: "n", course_id: "c", avg_score: 9, critical: 0 }] }} />,
    );
    expect(screen.getByText("R")).toBeInTheDocument();
    rerender(
      <CardView card={{ type: "compare", title: "C", rows: [{ label: "l", a: 1, b: 2, delta: 1 }] }} />,
    );
    expect(screen.getByText("C")).toBeInTheDocument();
  });
});

describe("BlockList", () => {
  it("renders ordered [text|card] blocks preserving order", () => {
    const blocks: Block[] = [
      { type: "card", card: { type: "stats", title: "Сводка", metrics: [{ label: "Балл", value: "70%" }] } },
      { type: "text", text: "Самый сложный вопрос — про «Шесть сигм»." },
    ];
    const { container } = render(<BlockList blocks={blocks} />);
    expect(screen.getByText("Сводка")).toBeInTheDocument();
    expect(screen.getByText(/Шесть сигм/)).toBeInTheDocument();
    // order: the card's title node must appear before the text node in the DOM
    const cardEl = screen.getByText("Сводка");
    const textEl = screen.getByText(/Шесть сигм/);
    expect(cardEl.compareDocumentPosition(textEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container).toBeTruthy();
  });

  it("renders text-only assistant messages", () => {
    render(<BlockList blocks={[{ type: "text", text: "Готово." }]} />);
    expect(screen.getByText("Готово.")).toBeInTheDocument();
  });
});
