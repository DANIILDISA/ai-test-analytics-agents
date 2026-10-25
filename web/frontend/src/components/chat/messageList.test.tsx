// web/frontend/src/components/chat/messageList.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MessageList } from "@/components/chat/MessageList";
import type { ThreadMessage } from "@/types/chat";

afterEach(() => vi.restoreAllMocks());

// A report deliverable carried on an assistant turn: a "report" card whose markdown is
// the full report text. The title is deliberately distinct from the markdown body so the
// title assertion can't accidentally match the preformatted box.
const REPORT_MD = [
  "# Анализ группы",
  "",
  "Средний балл: 70%",
  "- Вопрос 3 — самый сложный",
].join("\n");

function reportMessage(): ThreadMessage {
  return {
    role: "assistant",
    blocks: [
      { type: "text", text: "Готово, отчёт сформирован." },
      { type: "card", card: { type: "report", title: "Отчёт по группе А–12", markdown: REPORT_MD } },
    ],
    ts: "2026-06-24T10:00:00",
  };
}

describe("MessageList — report card", () => {
  it("renders the report title and its markdown faithfully as preformatted text", () => {
    render(<MessageList messages={[reportMessage()]} />);
    // Title and the surrounding prose still show.
    expect(screen.getByText("Отчёт по группе А–12")).toBeInTheDocument();
    expect(screen.getByText("Готово, отчёт сформирован.")).toBeInTheDocument();
    // The raw report text is shown as-is (no markdown parsing): both the heading marker
    // and the bullet line survive verbatim inside one preformatted block.
    expect(screen.getByText(/Анализ группы/)).toBeInTheDocument();
    expect(screen.getByText(/Средний балл: 70%/)).toBeInTheDocument();
    expect(screen.getByText(/самый сложный/)).toBeInTheDocument();
  });

  it("offers «Скачать .md» and «Копировать» controls", () => {
    render(<MessageList messages={[reportMessage()]} />);
    expect(screen.getByRole("button", { name: /Скачать \.md/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Копировать/ })).toBeInTheDocument();
  });

  it("«Копировать» writes the report text to the clipboard", () => {
    const writeText = vi.fn();
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      render(<MessageList messages={[reportMessage()]} />);
      fireEvent.click(screen.getByRole("button", { name: /Копировать/ }));
      expect(writeText).toHaveBeenCalledWith(REPORT_MD);
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    }
  });

  it("«Копировать» is a graceful no-op when the Clipboard API is unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    try {
      render(<MessageList messages={[reportMessage()]} />);
      // Must not throw when navigator.clipboard is missing.
      expect(() =>
        fireEvent.click(screen.getByRole("button", { name: /Копировать/ })),
      ).not.toThrow();
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    }
  });
});
