// web/frontend/src/api/client.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  listThreads,
  getThread,
  createThread,
  deleteThread,
  uploadChatFiles,
  getSettings,
  analyzeRun,
  listRuns,
  getRun,
  compareRuns,
} from "@/api/client";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

afterEach(() => vi.restoreAllMocks());

describe("REST client", () => {
  it("listThreads GETs /threads and returns the index", async () => {
    const meta = [{ id: "t1", title: "A", category: "Анализ", context: null, created_at: "x", updated_at: "y" }];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(meta));
    vi.stubGlobal("fetch", fetchMock);
    const out = await listThreads();
    expect(fetchMock).toHaveBeenCalledWith("/threads", expect.objectContaining({ method: "GET" }));
    expect(out[0].title).toBe("A");
  });

  it("getThread GETs /threads/:id", async () => {
    const thread = { id: "t1", title: "A", category: "Анализ", context: null, created_at: "x", updated_at: "y", messages: [] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(thread));
    vi.stubGlobal("fetch", fetchMock);
    const out = await getThread("t1");
    expect(fetchMock).toHaveBeenCalledWith("/threads/t1", expect.objectContaining({ method: "GET" }));
    expect(out.messages).toEqual([]);
  });

  it("createThread POSTs title/category/context", async () => {
    const created = { id: "t2", title: "Новый чат", category: "Анализ", context: null, created_at: "x", updated_at: "y", messages: [] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(created));
    vi.stubGlobal("fetch", fetchMock);
    const out = await createThread({ title: "Новый чат", category: "Анализ", context: null });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ title: "Новый чат", category: "Анализ", context: null });
    expect(out.id).toBe("t2");
  });

  it("getSettings reads the chat_agent default effort", async () => {
    const settings = { components: { chat_agent: { provider: "openrouter", model: "x", params: { effort: "medium" } } } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(settings)));
    const out = await getSettings();
    expect(out.components.chat_agent.params.effort).toBe("medium");
  });

  it("deleteThread DELETEs /threads/:id and resolves", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, true, 204));
    vi.stubGlobal("fetch", fetchMock);
    await expect(deleteThread("t1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/threads/t1",
      expect.objectContaining({ method: "DELETE", headers: { Accept: "application/json" } }),
    );
  });

  it("deleteThread rejects with the Russian `detail` on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ detail: "Тред не найден." }, false, 404)),
    );
    await expect(deleteThread("missing")).rejects.toThrow("Тред не найден.");
  });

  it("uploadChatFiles POSTs multipart to /chat/:id/uploads and returns the manifest", async () => {
    const manifest = {
      uploads: [
        { filename: "a.xlsx", stored: "stored-a.xlsx", kind: "massiv", size: 11 },
        { filename: "ref.xlsx", stored: "stored-ref.xlsx", kind: "etalon", size: 22 },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(manifest));
    vi.stubGlobal("fetch", fetchMock);

    const xlsx = (name: string) => new File(["x"], name);
    const out = await uploadChatFiles("t1", [xlsx("a.xlsx"), xlsx("ref.xlsx")]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/chat/t1/uploads");
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    // Every file is appended under the same "files" key (list[UploadFile] on the server).
    expect((form.getAll("files") as File[]).map((f) => f.name)).toEqual(["a.xlsx", "ref.xlsx"]);
    expect(out.uploads[0].kind).toBe("massiv");
    expect(out.uploads[1].stored).toBe("stored-ref.xlsx");
  });

  it("uploadChatFiles rejects with the Russian `detail` on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ detail: "Файл повреждён." }, false, 400)),
    );
    await expect(uploadChatFiles("t1", [new File(["x"], "bad.xlsx")])).rejects.toThrow(
      "Файл повреждён.",
    );
  });

  // /chat/confirm is an SSE endpoint consumed by streamConfirm (api/chatStream.ts),
  // not a JSON POST — see chatStream/ChatScreen tests for its streaming behavior.
});

describe("REST client — analysis tabs", () => {
  const xlsx = (name: string) =>
    new File(["x"], name, {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

  it("analyzeRun POSTs multipart with files + params and returns the result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ run_id: "r9" }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await analyzeRun({
      answers: [xlsx("a.xlsx"), xlsx("b.xlsx")],
      reference: xlsx("ref.xlsx"),
      modelGroup: "foreign",
      mode: "all",
      maxLlmCalls: 0,
      useInsights: true,
      insightBlocks: ["diagnosis", "why_failed"],
      insightNote: "обрати внимание на группу 3",
      courseId: "069",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/analyze");
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    // Each group file becomes its own "answers" entry (list[UploadFile] on the server).
    expect((form.getAll("answers") as File[]).map((f) => f.name)).toEqual(["a.xlsx", "b.xlsx"]);
    expect((form.get("reference") as File).name).toBe("ref.xlsx");
    expect(form.get("model_group")).toBe("foreign");
    expect(form.get("mode")).toBe("all");
    expect(form.get("max_llm_calls")).toBe("0");
    expect(form.get("course_id")).toBe("069");
    expect(form.get("use_insights")).toBe("true");
    expect(form.getAll("insight_blocks")).toEqual(["diagnosis", "why_failed"]);
    expect(form.get("insight_note")).toBe("обрати внимание на группу 3");
    expect(out.run_id).toBe("r9");
  });

  it("analyzeRun omits the reference part when none is chosen", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ run_id: "r1" }));
    vi.stubGlobal("fetch", fetchMock);
    await analyzeRun({
      answers: [xlsx("a.xlsx")],
      reference: null,
      modelGroup: "russian",
      mode: "answer",
      maxLlmCalls: 5,
      useInsights: false,
      insightBlocks: [],
    });
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get("reference")).toBeNull();
    expect(form.get("course_id")).toBe("анализ"); // default label
  });

  it("analyzeRun throws the Russian `detail` on a 4xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ detail: "Ошибка анализа: нет ключа." }, false, 400)),
    );
    await expect(
      analyzeRun({
        answers: [xlsx("a.xlsx")],
        modelGroup: "foreign",
        mode: "all",
        maxLlmCalls: 0,
        useInsights: false,
        insightBlocks: [],
      }),
    ).rejects.toThrow("Ошибка анализа: нет ключа.");
  });

  it("listRuns GETs /runs", async () => {
    const meta = [{ id: "r1", name: "Курс", summary: { avg_score: 0.7 } }];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(meta));
    vi.stubGlobal("fetch", fetchMock);
    const out = await listRuns();
    expect(fetchMock).toHaveBeenCalledWith("/runs", expect.objectContaining({ method: "GET" }));
    expect(out[0].id).toBe("r1");
  });

  it("getRun GETs /runs/:id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ run_id: "r1", course_id: "069" }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await getRun("r1");
    expect(fetchMock).toHaveBeenCalledWith("/runs/r1", expect.objectContaining({ method: "GET" }));
    expect(out.course_id).toBe("069");
  });

  it("compareRuns POSTs the two run ids to /compare", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ summary_delta: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await compareRuns("a", "b");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/compare");
    expect(JSON.parse(init.body)).toEqual({ run_id_a: "a", run_id_b: "b" });
  });
});
