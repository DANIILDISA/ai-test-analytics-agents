// web/frontend/src/components/chat/parts.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThreadSidebar } from "@/components/chat/ThreadSidebar";
import { EffortSelector } from "@/components/chat/EffortSelector";
import { ConfirmDialog } from "@/components/chat/ConfirmDialog";
import type { ThreadMeta, ConfirmEvent } from "@/types/chat";

// ContextBar now takes a {runs:[...]} list + runsById and renders one card per attached
// analysis with a per-run «Отвязать»; its tests live in contextBar.test.tsx. Per-row chat
// delete lives in threadSidebar.test.tsx. This file keeps the sidebar list/rename/filter,
// effort selector, and confirm-dialog wording coverage.

const THREADS: ThreadMeta[] = [
  { id: "t1", title: "Анализ группы 1", category: "Анализ", context: { run_id: "r1" }, created_at: "x", updated_at: "y" },
  { id: "t2", title: "Сравнение мая и июня", category: "Сравнение", context: null, created_at: "x", updated_at: "y" },
  { id: "t3", title: "Курс 069", category: "Курс", context: { course: "069" }, created_at: "x", updated_at: "y" },
];

describe("ThreadSidebar", () => {
  it("lists threads and highlights the active one", () => {
    render(<ThreadSidebar threads={THREADS} activeId="t2" onSelect={() => {}} onNew={() => {}} onRename={() => {}} onDelete={() => {}} />);
    expect(screen.getByText("Анализ группы 1")).toBeInTheDocument();
    const active = screen.getByText("Сравнение мая и июня").closest("div")!;
    // Active row gets the brand-blue tinted background (light bg + left accent bar).
    expect(active.className).toContain("bg-korpus-blue");
  });

  it("fires onNew when '+ Новый чат' is clicked", async () => {
    const onNew = vi.fn();
    render(<ThreadSidebar threads={THREADS} activeId={null} onSelect={() => {}} onNew={onNew} onRename={() => {}} onDelete={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /Новый чат/ }));
    expect(onNew).toHaveBeenCalledOnce();
  });

  it("renames a thread via the pencil + Enter (R2-1)", async () => {
    const onRename = vi.fn();
    render(
      <ThreadSidebar threads={THREADS} activeId={null} onSelect={() => {}} onNew={() => {}} onRename={onRename} onDelete={() => {}} />,
    );
    await userEvent.click(screen.getAllByRole("button", { name: "Переименовать чат" })[0]);
    const input = screen.getByDisplayValue("Анализ группы 1");
    await userEvent.clear(input);
    await userEvent.type(input, "Переименованный{Enter}");
    expect(onRename).toHaveBeenCalledWith("t1", "Переименованный");
  });

  it("filter chip 'Сравнение' shows only Сравнение threads", async () => {
    render(<ThreadSidebar threads={THREADS} activeId={null} onSelect={() => {}} onNew={() => {}} onRename={() => {}} onDelete={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Сравнение" }));
    expect(screen.getByText("Сравнение мая и июня")).toBeInTheDocument();
    expect(screen.queryByText("Анализ группы 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Курс 069")).not.toBeInTheDocument();
  });

  it("filter chip 'Все' shows every thread", async () => {
    render(<ThreadSidebar threads={THREADS} activeId={null} onSelect={() => {}} onNew={() => {}} onRename={() => {}} onDelete={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Анализ" }));
    await userEvent.click(screen.getByRole("button", { name: "Все" }));
    expect(screen.getByText("Курс 069")).toBeInTheDocument();
  });
});

describe("EffortSelector", () => {
  it("renders three Russian levels and maps to low|medium|high", async () => {
    const onChange = vi.fn();
    render(<EffortSelector value="medium" onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Низкий" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Высокий" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Высокий" }));
    expect(onChange).toHaveBeenCalledWith("high");
  });

  it("marks the current level active", () => {
    render(<EffortSelector value="medium" onChange={() => {}} />);
    const mid = screen.getByRole("button", { name: "Средний" });
    expect(mid.className).toContain("bg-korpus-blue");
  });
});

describe("ConfirmDialog", () => {
  it("uses the run_analysis wording for a run_analysis confirm event", () => {
    const request: ConfirmEvent = { event: "confirm", name: "run_analysis", arguments: { course: "069" } };
    render(<ConfirmDialog request={request} onResolve={() => {}} />);
    expect(screen.getByText("Запустить анализ по приложенным файлам?")).toBeInTheDocument();
    expect(screen.getByText(/Модель — из Настроек/)).toBeInTheDocument();
    // The arguments preview and the buttons stay intact.
    expect(screen.getByText(/"course": "069"/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Подтвердить" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отмена" })).toBeInTheDocument();
  });

  it("falls back to a generic title for an unknown tool name", () => {
    const request: ConfirmEvent = { event: "confirm", name: "delete_run", arguments: {} };
    render(<ConfirmDialog request={request} onResolve={() => {}} />);
    expect(screen.getByText("Подтвердить действие «delete_run»?")).toBeInTheDocument();
    expect(screen.queryByText("Запустить анализ по приложенным файлам?")).not.toBeInTheDocument();
  });
});
