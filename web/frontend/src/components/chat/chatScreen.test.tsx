// web/frontend/src/components/chat/chatScreen.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ChatScreen } from "@/components/chat/ChatScreen";
import type { ChatEvent, ThreadMeta, Thread } from "@/types/chat";
import type { RunMeta } from "@/api/client";

const META: ThreadMeta[] = [
  { id: "t1", title: "Анализ группы 1", category: "Анализ", context: { run_id: "r1" }, created_at: "x", updated_at: "y" },
];
const THREAD: Thread = { ...META[0], messages: [] };

const RUNS: RunMeta[] = [
  { id: "r1", created_at: "2026-01-01T00:00", name: "Первый анализ", course_id: "c1", model_group: "foreign", mode: "analysis", summary: { total_users: 10, total_questions: 5, avg_score: 80, critical: 1 } },
  { id: "r2", created_at: "2026-02-01T00:00", name: "Второй анализ", course_id: "c2", model_group: "foreign", mode: "analysis", summary: { total_users: 12, total_questions: 6, avg_score: 70, critical: 2 } },
];

function makeApi(events: ChatEvent[], runs: RunMeta[] = []) {
  return {
    listThreads: vi.fn().mockResolvedValue(META),
    getThread: vi.fn().mockResolvedValue(THREAD),
    createThread: vi.fn().mockResolvedValue(THREAD),
    getSettings: vi.fn().mockResolvedValue({ chat_agent: { provider: "p", model: "m", params: { effort: "medium" } } }),
    listRuns: vi.fn().mockResolvedValue(runs),
    patchThread: vi.fn().mockResolvedValue(THREAD),
    deleteThread: vi.fn().mockResolvedValue(undefined),
    uploadFiles: vi.fn().mockResolvedValue({ uploads: [] }),
    removeUpload: vi.fn().mockResolvedValue({ uploads: [] }),
    streamConfirm: vi.fn().mockImplementation(async (_req, onEvent: (e: ChatEvent) => void) => {
      onEvent({ event: "token", text: "Анализ перезапущен." });
      onEvent({ event: "done" });
    }),
    streamChat: vi.fn().mockImplementation(async (_req, onEvent: (e: ChatEvent) => void) => {
      for (const e of events) onEvent(e);
    }),
    stopChat: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ChatScreen", () => {
  it("loads threads on mount and shows them in the sidebar", async () => {
    render(
      <MemoryRouter>
        <ChatScreen api={makeApi([])} />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Анализ группы 1")).toBeInTheDocument();
  });

  it("surfaces a failed /threads load as an error banner, distinct from the empty state", async () => {
    const api = makeApi([]);
    api.listThreads.mockRejectedValue(new Error("boom"));
    render(
      <MemoryRouter>
        <ChatScreen api={api} />
      </MemoryRouter>,
    );
    // The honest banner tells the user the API failed…
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Не удалось загрузить диалоги. Обновите страницу.");
    // …and it is a SEPARATE signal from the genuinely-empty sidebar copy, so the
    // user can tell «API упал» from «диалогов действительно нет».
    expect(banner).not.toHaveTextContent("Диалогов пока нет");
    expect(screen.getByText(/Диалогов пока нет/)).toBeInTheDocument();
  });

  it("shows no error banner on the normal resolved load path", async () => {
    render(
      <MemoryRouter>
        <ChatScreen api={makeApi([])} />
      </MemoryRouter>,
    );
    await screen.findByText("Анализ группы 1");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Не удалось загрузить диалоги. Обновите страницу."),
    ).not.toBeInTheDocument();
  });

  it("streams a turn: status → card → tokens → done, rendering card then prose", async () => {
    const api = makeApi([
      { event: "status", text: "Читаю анализ…" },
      { event: "card", card: { type: "list", title: "Критические вопросы", items: [{ text: "Шесть сигм", value: "7.0%" }] } },
      { event: "token", text: "Самый сложный — " },
      { event: "token", text: "про «Шесть сигм»." },
      { event: "done" },
    ]);
    render(
      <MemoryRouter>
        <ChatScreen api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("Анализ группы 1");
    await userEvent.click(screen.getByText("Анализ группы 1"));
    await userEvent.type(screen.getByPlaceholderText(/Напишите вопрос агенту/), "Что самое сложное?");
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));

    expect(await screen.findByText("Критические вопросы")).toBeInTheDocument();
    expect(await screen.findByText(/Самый сложный — про «Шесть сигм»\./)).toBeInTheDocument();
    expect(api.streamChat).toHaveBeenCalledOnce();
  });

  it("renders the confirm dialog on a confirm event and streams the resumed turn on approve", async () => {
    const api = makeApi([
      { event: "confirm", name: "run_analysis", arguments: { params: { max_llm_calls: 20 } } },
    ]);
    render(
      <MemoryRouter>
        <ChatScreen api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("Анализ группы 1");
    await userEvent.click(screen.getByText("Анализ группы 1"));
    await userEvent.type(screen.getByPlaceholderText(/Напишите вопрос агенту/), "перезапусти");
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));

    expect(await screen.findByText(/запустить анализ/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Подтвердить" }));
    await waitFor(() =>
      expect(api.streamConfirm).toHaveBeenCalledWith(
        { thread_id: "t1", approve: true },
        expect.any(Function),
      ),
    );
    // The resumed turn's streamed comment lands in the same assistant bubble.
    expect(await screen.findByText("Анализ перезапущен.")).toBeInTheDocument();
  });

  it("shows a graceful error block on an error event", async () => {
    const api = makeApi([{ event: "error", text: "Не удалось обратиться к модели." }]);
    render(
      <MemoryRouter>
        <ChatScreen api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("Анализ группы 1");
    await userEvent.click(screen.getByText("Анализ группы 1"));
    await userEvent.type(screen.getByPlaceholderText(/Напишите вопрос агенту/), "вопрос");
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
    expect(await screen.findByText("Не удалось обратиться к модели.")).toBeInTheDocument();
  });

  it("«Очистить чат» wipes the messages and persists via patchThread (#9)", async () => {
    const api = makeApi([]);
    render(
      <MemoryRouter>
        <ChatScreen api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("Анализ группы 1");
    await userEvent.click(screen.getByText("Анализ группы 1"));
    await userEvent.click(screen.getByRole("button", { name: /Очистить чат/ }));
    await waitFor(() =>
      expect(api.patchThread).toHaveBeenCalledWith("t1", { clear_messages: true }),
    );
  });

  it("shows the grounding disclaimer in the footer", async () => {
    render(
      <MemoryRouter>
        <ChatScreen api={makeApi([])} />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/ответы могут содержать статистические оценки/i)).toBeInTheDocument();
  });

  it("appends a second run to the context list when attaching — keeps BOTH ids (#R2)", async () => {
    const api = makeApi([], RUNS);
    render(
      <MemoryRouter>
        <ChatScreen api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("Анализ группы 1");
    await userEvent.click(screen.getByText("Анализ группы 1")); // thread already pins r1
    await userEvent.click(screen.getByRole("button", { name: "Прикрепить анализ" }));
    await userEvent.click(await screen.findByRole("button", { name: /Второй анализ/ }));
    await waitFor(() =>
      expect(api.patchThread).toHaveBeenCalledWith("t1", { context: { runs: ["r1", "r2"] } }),
    );
  });

  it("detaching one of several runs patches the context with the remaining id", async () => {
    const api = makeApi([]);
    api.getThread.mockResolvedValue({ ...THREAD, context: { runs: ["r1", "r2"] } });
    render(
      <MemoryRouter>
        <ChatScreen api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("Анализ группы 1");
    await userEvent.click(screen.getByText("Анализ группы 1"));
    await userEvent.click(await screen.findByRole("button", { name: "Открепить анализ r1" }));
    await waitFor(() =>
      expect(api.patchThread).toHaveBeenCalledWith("t1", { context: { runs: ["r2"] } }),
    );
  });

  it("many attached analyses and files stay compact: one summary line each, expandable", async () => {
    const runs: RunMeta[] = Array.from({ length: 5 }, (_, i) => ({
      ...RUNS[0],
      id: `m${i}`,
      name: `Анализ номер ${i + 1}`,
    }));
    const api = makeApi([], runs);
    const uploads = Array.from({ length: 6 }, (_, i) => ({
      filename: `Массив ответов ${i}.xlsx`,
      stored: `u${i}.xlsx`,
      kind: "massiv" as const,
      size: 10,
    }));
    api.getThread.mockResolvedValue({ ...THREAD, context: { runs: runs.map((r) => r.id) }, uploads });
    render(
      <MemoryRouter>
        <ChatScreen api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("Анализ группы 1");
    await userEvent.click(screen.getByText("Анализ группы 1"));
    // Analyses: collapsed behind «5 анализов прикреплено» (no row, no ✕ until expanded).
    const toggle = await screen.findByRole("button", { name: /5 анализов прикреплено/ });
    expect(screen.queryByTestId("context-run")).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.getAllByTestId("context-run")).toHaveLength(5);
    // Files: first three chips + «ещё 3 файла».
    expect(screen.getAllByTestId("staged-file")).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "ещё 3 файла" }));
    expect(screen.getAllByTestId("staged-file")).toHaveLength(6);
  });

  it("detaching the last run clears the context entirely (detach:true)", async () => {
    const api = makeApi([]);
    api.getThread.mockResolvedValue({ ...THREAD, context: { runs: ["r1"] } });
    render(
      <MemoryRouter>
        <ChatScreen api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("Анализ группы 1");
    await userEvent.click(screen.getByText("Анализ группы 1"));
    await userEvent.click(await screen.findByRole("button", { name: "Открепить анализ r1" }));
    await waitFor(() =>
      expect(api.patchThread).toHaveBeenCalledWith("t1", { detach: true }),
    );
  });

  it("deletes a thread: confirm true calls api.deleteThread and removes the row (#T9)", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const api = makeApi([]);
    render(
      <MemoryRouter>
        <ChatScreen api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("Анализ группы 1");
    await userEvent.click(screen.getByRole("button", { name: "Удалить чат" }));
    await userEvent.click(screen.getByRole("button", { name: "Подтвердить удаление" }));
    await waitFor(() => expect(api.deleteThread).toHaveBeenCalledWith("t1"));
    await waitFor(() =>
      expect(screen.queryByText("Анализ группы 1")).not.toBeInTheDocument(),
    );
    confirmSpy.mockRestore();
  });

  it("deleting the active thread clears the message pane (#T9)", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const api = makeApi([
      { event: "token", text: "Ответ агента." },
      { event: "done" },
    ]);
    render(
      <MemoryRouter>
        <ChatScreen api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("Анализ группы 1");
    await userEvent.click(screen.getByText("Анализ группы 1")); // open → active thread
    await userEvent.type(screen.getByPlaceholderText(/Напишите вопрос агенту/), "вопрос");
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
    expect(await screen.findByText("Ответ агента.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Удалить чат" }));
    await userEvent.click(screen.getByRole("button", { name: "Подтвердить удаление" }));
    await waitFor(() => expect(api.deleteThread).toHaveBeenCalledWith("t1"));
    // Message pane falls back to the honest empty state, streamed turn gone.
    await waitFor(() =>
      expect(screen.queryByText("Ответ агента.")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Выберите или создайте чат")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("uploads files: calls api.uploadFiles(threadId, files) and shows staged chips with kind badges (#T15)", async () => {
    const api = makeApi([]);
    // After the upload the thread is refetched WITH the server-classified attachments.
    api.getThread
      .mockResolvedValueOnce(THREAD)
      .mockResolvedValue({
        ...THREAD,
        uploads: [
          { filename: "ответы.xlsx", stored: "s1.xlsx", kind: "massiv", size: 10 },
          { filename: "эталон.xlsx", stored: "s2.xlsx", kind: "etalon", size: 20 },
        ],
      });
    const { container } = render(
      <MemoryRouter>
        <ChatScreen api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("Анализ группы 1");
    await userEvent.click(screen.getByText("Анализ группы 1")); // open → active thread

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const answers = new File(["a"], "ответы.xlsx");
    const reference = new File(["b"], "эталон.xlsx");
    await userEvent.upload(fileInput, [answers, reference]);

    await waitFor(() =>
      expect(api.uploadFiles).toHaveBeenCalledWith("t1", [answers, reference]),
    );
    // Staged chips render the filenames + a массив/эталон kind badge each.
    expect(await screen.findByText("ответы.xlsx")).toBeInTheDocument();
    expect(await screen.findByText("эталон.xlsx")).toBeInTheDocument();
    expect(screen.getByText("массив")).toBeInTheDocument();
    expect(screen.getByText("эталон")).toBeInTheDocument();
  });

  it("refetches the thread after a confirmed run_analysis so the new run appears in context (#T15)", async () => {
    const api = makeApi(
      [{ event: "confirm", name: "run_analysis", arguments: { params: { max_llm_calls: 20 } } }],
      RUNS,
    );
    // First open pins only r1; the confirmed run appends r2 server-side.
    api.getThread
      .mockResolvedValueOnce(THREAD)
      .mockResolvedValue({ ...THREAD, context: { runs: ["r1", "r2"] } });
    render(
      <MemoryRouter>
        <ChatScreen api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("Анализ группы 1");
    await userEvent.click(screen.getByText("Анализ группы 1"));
    // Before the run, only the first analysis is bound in the context bar.
    expect(screen.queryByText("Второй анализ")).not.toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText(/Напишите вопрос агенту/), "перезапусти");
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await screen.findByText(/запустить анализ/i);
    await userEvent.click(screen.getByRole("button", { name: "Подтвердить" }));

    // The resumed comment still lands AND the refetch surfaces the newly-bound run.
    expect(await screen.findByText("Анализ перезапущен.")).toBeInTheDocument();
    expect(await screen.findByText("Второй анализ")).toBeInTheDocument();
  });

  it("concatenates incremental token deltas into one streamed answer (Phase 2)", async () => {
    const api = makeApi([
      { event: "token", text: "Часть один " },
      { event: "token", text: "и часть два." },
      { event: "done" },
    ]);
    render(
      <MemoryRouter>
        <ChatScreen api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("Анализ группы 1");
    await userEvent.click(screen.getByText("Анализ группы 1"));
    await userEvent.type(screen.getByPlaceholderText(/Напишите вопрос агенту/), "вопрос");
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
    // The two deltas land in a SINGLE text block, not two separate fragments.
    expect(await screen.findByText("Часть один и часть два.")).toBeInTheDocument();
  });

  it("renders a «Ход рассуждений» trace panel from a tool event before the prose (Phase 2)", async () => {
    const api = makeApi([
      { event: "tool", name: "read_analysis", summary: "Прочитал анализ r1: средний балл 80%." },
      { event: "token", text: "Готово." },
      { event: "done" },
    ]);
    render(
      <MemoryRouter>
        <ChatScreen api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("Анализ группы 1");
    await userEvent.click(screen.getByText("Анализ группы 1"));
    await userEvent.type(screen.getByPlaceholderText(/Напишите вопрос агенту/), "вопрос");
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));

    // The collapsible toggle appears for the assistant message…
    const toggle = await screen.findByText("Ход рассуждений");
    expect(toggle).toBeInTheDocument();
    // …and its content includes the tool's one-line Russian summary.
    await userEvent.click(toggle);
    expect(screen.getByText(/Прочитал анализ r1/)).toBeInTheDocument();
    // The final prose is still shown alongside the trace.
    expect(await screen.findByText("Готово.")).toBeInTheDocument();
  });

  it("every staged attachment chip has a × that removes it (persisted via api.removeUpload)", async () => {
    const api = makeApi([]);
    const staged = [
      { filename: "Эталон ответов 069.xlsx", stored: "s1.xlsx", kind: "etalon", size: 10 },
      { filename: "ответы.xlsx", stored: "s2.xlsx", kind: "massiv", size: 20 },
    ];
    api.getThread.mockResolvedValue({ ...THREAD, uploads: staged });
    api.removeUpload.mockResolvedValue({ uploads: [staged[1]] });
    render(
      <MemoryRouter>
        <ChatScreen api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("Анализ группы 1");
    await userEvent.click(screen.getByText("Анализ группы 1"));
    expect(await screen.findByText("Эталон ответов 069.xlsx")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Убрать файл/ })).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Убрать файл Эталон ответов 069.xlsx" }));
    await waitFor(() => expect(api.removeUpload).toHaveBeenCalledWith("t1", "s1.xlsx"));
    await waitFor(() => expect(screen.queryByText("Эталон ответов 069.xlsx")).not.toBeInTheDocument());
    expect(screen.getByText("ответы.xlsx")).toBeInTheDocument();
  });

  it("a single-call answer carries no «Ход рассуждений» panel", async () => {
    const api = makeApi([
      { event: "token", text: "Сдали пятеро." },
      { event: "done" },
    ]);
    render(
      <MemoryRouter>
        <ChatScreen api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("Анализ группы 1");
    await userEvent.click(screen.getByText("Анализ группы 1"));
    await userEvent.type(screen.getByPlaceholderText(/Напишите вопрос агенту/), "сколько сдали");
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
    expect(await screen.findByText("Сдали пятеро.")).toBeInTheDocument();
    expect(screen.queryByText("Ход рассуждений")).not.toBeInTheDocument();
  });

  it("the trace panel hides internal tool names", async () => {
    const api = makeApi([
      { event: "tool", name: "query_stats", summary: "query_stats: критические вопросы прогона r1" },
      { event: "token", text: "Готово." },
      { event: "done" },
    ]);
    render(
      <MemoryRouter>
        <ChatScreen api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("Анализ группы 1");
    await userEvent.click(screen.getByText("Анализ группы 1"));
    await userEvent.type(screen.getByPlaceholderText(/Напишите вопрос агенту/), "вопрос");
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await userEvent.click(await screen.findByText("Ход рассуждений"));
    expect(screen.getByText("Критические вопросы прогона r1")).toBeInTheDocument();
    expect(screen.queryByText(/query_stats/)).not.toBeInTheDocument();
  });

  it("«Стоп» during streaming calls api.stopChat(threadId) (Phase 2)", async () => {
    const api = makeApi([]);
    // Hold the SSE open so the turn stays in the streaming state and the «Стоп» button shows.
    api.streamChat.mockImplementation(() => new Promise<void>(() => {}));
    render(
      <MemoryRouter>
        <ChatScreen api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("Анализ группы 1");
    await userEvent.click(screen.getByText("Анализ группы 1"));
    await userEvent.type(screen.getByPlaceholderText(/Напишите вопрос агенту/), "вопрос");
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));

    // While streaming, the Stop control is visible; clicking it cancels the turn server-side.
    const stop = await screen.findByRole("button", { name: "Стоп" });
    await userEvent.click(stop);
    await waitFor(() => expect(api.stopChat).toHaveBeenCalledWith("t1"));
  });
});
