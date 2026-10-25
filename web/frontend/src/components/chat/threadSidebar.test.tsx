// web/frontend/src/components/chat/threadSidebar.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThreadSidebar } from "@/components/chat/ThreadSidebar";
import type { ThreadMeta } from "@/types/chat";

const THREADS: ThreadMeta[] = [
  { id: "t1", title: "Анализ группы 1", category: "Анализ", context: { run_id: "r1" }, created_at: "x", updated_at: "y" },
  { id: "t2", title: "Сравнение мая и июня", category: "Сравнение", context: null, created_at: "x", updated_at: "y" },
  { id: "t3", title: "Курс 069", category: "Курс", context: { course: "069" }, created_at: "x", updated_at: "y" },
];

describe("ThreadSidebar delete (T7)", () => {
  it("clicking the delete button reveals the inline confirm controls", async () => {
    const onDelete = vi.fn();
    render(
      <ThreadSidebar
        threads={THREADS}
        activeId={null}
        onSelect={() => {}}
        onNew={() => {}}
        onRename={() => {}}
        onDelete={onDelete}
      />,
    );
    // First click only arms the confirmation — it must NOT delete yet.
    await userEvent.click(screen.getAllByRole("button", { name: "Удалить чат" })[0]);
    expect(onDelete).not.toHaveBeenCalled();
    // The trailing controls swap to Check (confirm) + X (cancel) for that row.
    expect(screen.getByRole("button", { name: "Подтвердить удаление" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отменить удаление" })).toBeInTheDocument();
  });

  it("confirming the inline delete calls onDelete(id) and clears the confirm state", async () => {
    const onDelete = vi.fn();
    render(
      <ThreadSidebar
        threads={THREADS}
        activeId={null}
        onSelect={() => {}}
        onNew={() => {}}
        onRename={() => {}}
        onDelete={onDelete}
      />,
    );
    await userEvent.click(screen.getAllByRole("button", { name: "Удалить чат" })[0]);
    await userEvent.click(screen.getByRole("button", { name: "Подтвердить удаление" }));
    expect(onDelete).toHaveBeenCalledWith("t1");
    expect(onDelete).toHaveBeenCalledOnce();
    // Confirm controls collapse back; the row returns to its normal delete affordance.
    expect(screen.queryByRole("button", { name: "Подтвердить удаление" })).not.toBeInTheDocument();
  });

  it("cancelling the inline delete does not call onDelete and restores the row", async () => {
    const onDelete = vi.fn();
    render(
      <ThreadSidebar
        threads={THREADS}
        activeId={null}
        onSelect={() => {}}
        onNew={() => {}}
        onRename={() => {}}
        onDelete={onDelete}
      />,
    );
    await userEvent.click(screen.getAllByRole("button", { name: "Удалить чат" })[0]);
    await userEvent.click(screen.getByRole("button", { name: "Отменить удаление" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Подтвердить удаление" })).not.toBeInTheDocument();
    // The normal per-row delete buttons are back (one per thread).
    expect(screen.getAllByRole("button", { name: "Удалить чат" })).toHaveLength(THREADS.length);
  });

  it("rename still works while the delete confirm uses its own separate state", async () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();
    render(
      <ThreadSidebar
        threads={THREADS}
        activeId={null}
        onSelect={() => {}}
        onNew={() => {}}
        onRename={onRename}
        onDelete={onDelete}
      />,
    );
    // Arm delete on the first row…
    await userEvent.click(screen.getAllByRole("button", { name: "Удалить чат" })[0]);
    expect(screen.getByRole("button", { name: "Подтвердить удаление" })).toBeInTheDocument();
    // …then rename a different row; its rename machine must be unaffected.
    await userEvent.click(screen.getAllByRole("button", { name: "Переименовать чат" })[0]);
    const input = screen.getByDisplayValue("Сравнение мая и июня");
    await userEvent.clear(input);
    await userEvent.type(input, "Новое имя{Enter}");
    expect(onRename).toHaveBeenCalledWith("t2", "Новое имя");
    expect(onDelete).not.toHaveBeenCalled();
  });
});
