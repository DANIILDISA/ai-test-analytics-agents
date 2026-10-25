// web/frontend/src/components/chat/composer.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "@/components/chat/Composer";
import { ConfirmDialog } from "@/components/chat/ConfirmDialog";

describe("Composer — no analysis attached", () => {
  it("blocks sending and explains why", async () => {
    const onSend = vi.fn();
    render(
      <Composer effort="medium" onEffortChange={() => {}} onSend={onSend} onAttachRun={() => {}} onUseCurrent={() => {}} disabled={false} blockReason="Сначала выберите анализ" />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Сначала выберите анализ");
    expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText(/Напишите вопрос агенту/), "вопрос{Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("Composer", () => {
  it("sends the typed message and clears the input", async () => {
    const onSend = vi.fn();
    render(
      <Composer effort="medium" onEffortChange={() => {}} onSend={onSend} onAttachRun={() => {}} onUseCurrent={() => {}} disabled={false} />,
    );
    const input = screen.getByPlaceholderText(/Напишите вопрос агенту/) as HTMLInputElement;
    await userEvent.type(input, "Что самое сложное?");
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
    expect(onSend).toHaveBeenCalledWith("Что самое сложное?");
    expect(input.value).toBe("");
  });

  it("does not send blank/whitespace messages", async () => {
    const onSend = vi.fn();
    render(
      <Composer effort="medium" onEffortChange={() => {}} onSend={onSend} onAttachRun={() => {}} onUseCurrent={() => {}} disabled={false} />,
    );
    await userEvent.type(screen.getByPlaceholderText(/Напишите вопрос агенту/), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("disables Send while a turn is streaming", () => {
    render(
      <Composer effort="medium" onEffortChange={() => {}} onSend={() => {}} onAttachRun={() => {}} onUseCurrent={() => {}} disabled={true} />,
    );
    expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled();
  });

  it("attach buttons fire their callbacks", async () => {
    const onAttachRun = vi.fn();
    const onUseCurrent = vi.fn();
    render(
      <Composer effort="medium" onEffortChange={() => {}} onSend={() => {}} onAttachRun={onAttachRun} onUseCurrent={onUseCurrent} disabled={false} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Прикрепить анализ/ }));
    await userEvent.click(screen.getByRole("button", { name: /Использовать текущий результат/ }));
    expect(onAttachRun).toHaveBeenCalledOnce();
    expect(onUseCurrent).toHaveBeenCalledOnce();
  });

  it("selecting files via the hidden input calls onUploadFiles and resets the input", async () => {
    const onUploadFiles = vi.fn();
    const { container } = render(
      <Composer
        effort="medium"
        onEffortChange={() => {}}
        onSend={() => {}}
        onAttachRun={() => {}}
        onUseCurrent={() => {}}
        onUploadFiles={onUploadFiles}
        disabled={false}
      />,
    );
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const a = new File(["a"], "a.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const b = new File(["b"], "b.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await userEvent.upload(fileInput, [a, b]);
    expect(onUploadFiles).toHaveBeenCalledOnce();
    expect(onUploadFiles).toHaveBeenCalledWith([a, b]);
    expect(fileInput.value).toBe("");
  });
});

describe("ConfirmDialog", () => {
  it("shows the proposed params and resolves approve", async () => {
    const onResolve = vi.fn();
    render(
      <ConfirmDialog
        request={{ event: "confirm", name: "run_analysis", arguments: { params: { max_llm_calls: 20 } } }}
        onResolve={onResolve}
      />,
    );
    expect(screen.getByText(/Запустить анализ/)).toBeInTheDocument();
    expect(screen.getByText(/max_llm_calls/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Подтвердить" }));
    expect(onResolve).toHaveBeenCalledWith(true);
  });

  it("resolves cancel", async () => {
    const onResolve = vi.fn();
    render(
      <ConfirmDialog
        request={{ event: "confirm", name: "run_analysis", arguments: {} }}
        onResolve={onResolve}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onResolve).toHaveBeenCalledWith(false);
  });
});
