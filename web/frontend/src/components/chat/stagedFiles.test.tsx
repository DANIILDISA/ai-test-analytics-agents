// web/frontend/src/components/chat/stagedFiles.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StagedFiles } from "@/components/chat/StagedFiles";
import type { ChatUpload } from "@/api/client";

function file(i: number, name = `Массив ответов ${i}.xlsx`, kind: ChatUpload["kind"] = "massiv"): ChatUpload {
  return { filename: name, stored: `s${i}.xlsx`, kind, size: 100 };
}

describe("StagedFiles", () => {
  it("renders nothing without files", () => {
    const { container } = render(<StagedFiles files={[]} onRemove={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows every chip with its kind badge and removes the right one", async () => {
    const onRemove = vi.fn();
    render(
      <StagedFiles files={[file(1), file(2, "Эталон ответов.xlsx", "etalon")]} onRemove={onRemove} />,
    );
    expect(screen.getAllByTestId("staged-file")).toHaveLength(2);
    expect(screen.getByText("эталон")).toBeInTheDocument();
    expect(screen.getByText("массив")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Убрать файл Эталон ответов.xlsx" }));
    expect(onRemove).toHaveBeenCalledWith("s2.xlsx");
  });

  it("truncates a long filename and keeps the full name as a tooltip", () => {
    const long = "Массив_ответов_пользователей_итоговый_тест_выгрузка_из_СДО_за_2026_год_все_группы.xlsx";
    render(<StagedFiles files={[file(1, long)]} onRemove={() => {}} />);
    const name = screen.getByText(long);
    expect(name).toHaveAttribute("title", long);
    expect(name.className).toMatch(/truncate/);
  });

  it("folds 5+ files into the first three plus «ещё N файлов» and expands on click", async () => {
    const files = Array.from({ length: 9 }, (_, i) => file(i + 1));
    render(<StagedFiles files={files} onRemove={() => {}} />);
    expect(screen.getAllByTestId("staged-file")).toHaveLength(3);
    const more = screen.getByRole("button", { name: "ещё 6 файлов" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(more);
    expect(screen.getAllByTestId("staged-file")).toHaveLength(9);
    await userEvent.click(screen.getByRole("button", { name: "Свернуть" }));
    expect(screen.getAllByTestId("staged-file")).toHaveLength(3);
  });

  it("uses the Russian plural for the hidden count", () => {
    render(<StagedFiles files={Array.from({ length: 6 }, (_, i) => file(i + 1))} onRemove={() => {}} />);
    expect(screen.getByRole("button", { name: "ещё 3 файла" })).toBeInTheDocument();
  });

  it("does not collapse four files", () => {
    render(<StagedFiles files={Array.from({ length: 4 }, (_, i) => file(i + 1))} onRemove={() => {}} />);
    expect(screen.getAllByTestId("staged-file")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: /ещё/ })).not.toBeInTheDocument();
  });
});
