// web/frontend/src/components/cards/cards.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatsCard } from "@/components/cards/StatsCard";
import { ListCard } from "@/components/cards/ListCard";
import { RunsCard } from "@/components/cards/RunsCard";
import { CompareCard } from "@/components/cards/CompareCard";

/** Match the innermost element whose full (whitespace-collapsed) text equals the value,
 *  tolerating the StatsCard splitting it across a number node and a smaller unit node
 *  (e.g. "70.3" + "%"). Rejecting ancestors keeps the match unique. */
function valueText(expected: string) {
  const norm = (s: string | null) => (s ?? "").replace(/\s+/g, "");
  return (_content: string, el: Element | null) => {
    if (el == null || norm(el.textContent) !== expected) return false;
    return !Array.from(el.children).some((c) => norm(c.textContent) === expected);
  };
}

describe("card renderers", () => {
  it("StatsCard renders title + each metric label/value", () => {
    render(
      <StatsCard
        card={{ type: "stats", title: "Сводка анализа", metrics: [
          { label: "Средний балл", value: "70.3%" },
          { label: "Пользователи", value: "45" },
        ] }}
      />,
    );
    expect(screen.getByText("Сводка анализа")).toBeInTheDocument();
    expect(screen.getByText("Средний балл")).toBeInTheDocument();
    // The value renders the number large with a smaller trailing unit, so it spans
    // two nodes ("70.3" + "%"); assert on the combined element text (intent: value shown).
    expect(screen.getByText(valueText("70.3%"))).toBeInTheDocument();
    expect(screen.getByText("45")).toBeInTheDocument();
  });

  it("ListCard renders each item text + value", () => {
    render(
      <ListCard
        card={{ type: "list", title: "Критические вопросы", items: [
          { text: "Шесть сигм", value: "7.0%" },
        ] }}
      />,
    );
    expect(screen.getByText("Критические вопросы")).toBeInTheDocument();
    expect(screen.getByText("Шесть сигм")).toBeInTheDocument();
    expect(screen.getByText("7.0%")).toBeInTheDocument();
  });

  it("RunsCard renders a row per run with name/course/score and a critical mark", () => {
    render(
      <RunsCard
        card={{ type: "runs", title: "Анализы", items: [
          { id: "r1", name: "069", course_id: "069", avg_score: 70.3, critical: 2 },
          { id: "r2", name: "070", course_id: "070", avg_score: 80, critical: 0 },
        ] }}
      />,
    );
    expect(screen.getByText("Анализы")).toBeInTheDocument();
    expect(screen.getByText("70.3%")).toBeInTheDocument();
    expect(screen.getByText("80%")).toBeInTheDocument();
    // criticality badge shows the count only when > 0
    expect(screen.getByText("крит.: 2")).toBeInTheDocument();
    expect(screen.queryByText("крит.: 0")).not.toBeInTheDocument();
  });

  it("RunsCard tolerates null fields (н/д), per D13", () => {
    render(
      <RunsCard
        card={{ type: "runs", title: "Анализы", items: [
          { id: "r3", name: null, course_id: null, avg_score: null, critical: null },
        ] }}
      />,
    );
    expect(screen.getAllByText("н/д").length).toBeGreaterThan(0);
  });

  it("CompareCard renders a/b and colors delta (positive green, negative red)", () => {
    render(
      <CompareCard
        card={{ type: "compare", title: "Сравнение анализов", rows: [
          { label: "Средний балл", a: 60, b: 70, delta: 10 },
          { label: "Критические", a: null, b: null, delta: -2 },
        ] }}
      />,
    );
    expect(screen.getByText("Сравнение анализов")).toBeInTheDocument();
    const up = screen.getByText("+10");
    const down = screen.getByText("-2");
    expect(up.className).toContain("text-korpus-up");
    expect(down.className).toContain("text-korpus-down");
  });
});
