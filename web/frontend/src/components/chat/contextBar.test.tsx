// web/frontend/src/components/chat/contextBar.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextBar } from "@/components/chat/ContextBar";
import type { RunMeta } from "@/api/client";

function meta(id: string, name: string, course: string | null): RunMeta {
  return {
    id,
    created_at: "",
    name,
    course_id: course,
    model_group: "foreign",
    mode: "all",
    summary: { total_users: 12, total_questions: 106, avg_score: 70.8, critical: 9 },
  };
}

const RUNS: Record<string, RunMeta> = {
  a: meta("a", "Группа A.xlsx", "069"),
  b: meta("b", "Группа B.xlsx", "070"),
};

describe("ContextBar", () => {
  it("renders one analysis card per attached run", () => {
    render(<ContextBar context={{ runs: ["a", "b"] }} runsById={RUNS} onDetach={() => {}} />);
    expect(screen.getByText("Группа A.xlsx")).toBeInTheDocument();
    expect(screen.getByText("Группа B.xlsx")).toBeInTheDocument();
    // Two per-run «Открепить анализ» buttons → two cards.
    expect(screen.getAllByRole("button", { name: /Открепить анализ/ })).toHaveLength(2);
  });

  it("detaches only the run whose ✕ was clicked", async () => {
    const onDetach = vi.fn();
    render(<ContextBar context={{ runs: ["a", "b"] }} runsById={RUNS} onDetach={onDetach} />);
    const buttons = screen.getAllByRole("button", { name: /Открепить анализ/ });
    await userEvent.click(buttons[1]); // second card → run "b"
    expect(onDetach).toHaveBeenCalledTimes(1);
    expect(onDetach).toHaveBeenCalledWith("b");
  });

  it("shows the id and dashes metrics when a run's meta is not resolved", () => {
    render(<ContextBar context={{ runs: ["ghost"] }} runsById={{}} onDetach={() => {}} />);
    expect(screen.getByText("ghost")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2); // course + avg + users
  });

  it("shows the «не выбран» empty state when nothing is attached", () => {
    render(<ContextBar context={null} runsById={{}} onDetach={() => {}} />);
    expect(screen.getByText("Анализ не выбран")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Открепить анализ/ })).not.toBeInTheDocument();
  });

  it("shows one row for a single analysis and no collapse toggle", () => {
    render(<ContextBar context={{ runs: ["a"] }} runsById={RUNS} onDetach={() => {}} />);
    expect(screen.getByText("Группа A.xlsx")).toBeInTheDocument();
    expect(screen.getAllByTestId("context-run")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /прикреплено/ })).not.toBeInTheDocument();
  });

  it("detach is an icon-only ✕ with an accessible name and a tooltip (no visible label text)", () => {
    render(<ContextBar context={{ runs: ["a"] }} runsById={RUNS} onDetach={() => {}} />);
    const btn = screen.getByRole("button", { name: /Открепить анализ Группа A.xlsx/ });
    expect(btn).toHaveAttribute("title", "Открепить анализ");
    expect(btn.textContent).toBe(""); // icon only — nothing that could overlap the title text
  });

  it("keeps 3 analyses expanded as one row each", () => {
    const runs = { ...RUNS, c: meta("c", "Группа C.xlsx", "071") };
    render(<ContextBar context={{ runs: ["a", "b", "c"] }} runsById={runs} onDetach={() => {}} />);
    expect(screen.getAllByTestId("context-run")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /прикреплено/ })).not.toBeInTheDocument();
  });

  describe("with many attached analyses (4+)", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const runs: Record<string, RunMeta> = {
      ...RUNS,
      c: meta("c", "Группа C.xlsx", "071"),
      d: meta("d", "Группа D.xlsx", "072"),
      e: meta("e", "Группа E.xlsx", "073"),
      f: meta("f", "Группа F.xlsx", "074"),
    };

    it("collapses into one «N анализов прикреплено» line (header height stays bounded)", () => {
      render(<ContextBar context={{ runs: ids }} runsById={runs} onDetach={() => {}} />);
      expect(screen.getByRole("button", { name: /6 анализов прикреплено/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      expect(screen.queryAllByTestId("context-run")).toHaveLength(0);
      expect(screen.queryByRole("button", { name: /Открепить анализ/ })).not.toBeInTheDocument();
    });

    it("uses the right Russian plural form for 4 and 5", () => {
      const { unmount } = render(
        <ContextBar context={{ runs: ids.slice(0, 4) }} runsById={runs} onDetach={() => {}} />,
      );
      expect(screen.getByRole("button", { name: /4 анализа прикреплено/ })).toBeInTheDocument();
      unmount();
      render(<ContextBar context={{ runs: ids.slice(0, 5) }} runsById={runs} onDetach={() => {}} />);
      expect(screen.getByRole("button", { name: /5 анализов прикреплено/ })).toBeInTheDocument();
    });

    it("expands to one row per analysis and detaches the right one", async () => {
      const onDetach = vi.fn();
      render(<ContextBar context={{ runs: ids }} runsById={runs} onDetach={onDetach} />);
      await userEvent.click(screen.getByRole("button", { name: /6 анализов прикреплено/ }));
      expect(screen.getAllByTestId("context-run")).toHaveLength(6);
      expect(screen.getAllByRole("button", { name: /Открепить анализ/ })).toHaveLength(6);
      await userEvent.click(screen.getByRole("button", { name: "Открепить анализ Группа E.xlsx" }));
      expect(onDetach).toHaveBeenCalledWith("e");
      // …and it can be folded away again.
      await userEvent.click(screen.getByRole("button", { name: /6 анализов прикреплено/ }));
      expect(screen.queryAllByTestId("context-run")).toHaveLength(0);
    });

    it("never hides a deleted analysis behind the collapsed summary", () => {
      render(
        <ContextBar
          context={{ runs: [...ids, "gone"] }}
          runsById={runs}
          onDetach={() => {}}
          anyMissing
        />,
      );
      expect(screen.getByText("Анализ удалён")).toBeInTheDocument();
    });
  });

  it("gives a very long name a tooltip with the full text instead of overflowing", () => {
    const long = "Итоговая аттестация по курсу «Основы корпоративного обучения» ".repeat(4).trim();
    render(
      <ContextBar
        context={{ runs: ["long"] }}
        runsById={{ long: meta("long", long, "021") }}
        onDetach={() => {}}
      />,
    );
    const title = screen.getByText(long);
    expect(title).toHaveAttribute("title", long);
    expect(title.className).toMatch(/truncate/);
  });

  it("never renders an empty title: a nameless run falls back to its course, then its id", () => {
    render(
      <ContextBar
        context={{ runs: ["x", "y"] }}
        runsById={{ x: meta("x", "   ", "021"), y: meta("y", "", null) }}
        onDetach={() => {}}
      />,
    );
    const rows = screen.getAllByTestId("context-run");
    expect(rows[0]).toHaveTextContent("021");
    expect(rows[1]).toHaveTextContent("y");
  });
});
