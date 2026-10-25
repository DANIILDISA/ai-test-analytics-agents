// web/frontend/src/screens/newAnalysis.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { NewAnalysis } from "@/screens/NewAnalysis";

afterEach(() => vi.restoreAllMocks());

/** Mount NewAnalysis under a router. A sibling `/results` route echoes the location so
 *  tests can assert navigation + the ?run=<id> query param the Results screen reads. */
function renderScreen() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<NewAnalysis />} />
        <Route path="/results" element={<ResultsProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function ResultsProbe() {
  const loc = useLocation();
  return <div data-testid="results-probe">{`${loc.pathname}${loc.search}`}</div>;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

const DEFAULTS = {
  model_group: "russian",
  model: "GigaChat-3-Ultra",
  provider: "gigachat",
  deep: true,
  max_llm_calls: 500,
  aspects: ["why_failed", "diagnosis", "anomalies", "recommendations"],
};

/** Fake fetch: GET /settings -> saved defaults, POST /analyze -> `analyze` (a Response or a factory). */
function stubApi(opts: { defaults?: Record<string, unknown>; analyze?: Response | (() => Promise<Response>) } = {}) {
  const fetchMock = vi.fn((url: string) => {
    if (url === "/settings") {
      return Promise.resolve(jsonResponse({ components: {}, keys: {}, analysis_defaults: { ...DEFAULTS, ...opts.defaults } }));
    }
    if (url === "/analyze") {
      const a = opts.analyze ?? jsonResponse({ run_id: "r1" });
      return typeof a === "function" ? a() : Promise.resolve(a);
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The form of the POST /analyze call. */
function analyzeForm(fetchMock: ReturnType<typeof stubApi>): FormData {
  const call = fetchMock.mock.calls.find((c) => c[0] === "/analyze") as unknown as [string, RequestInit];
  return call[1].body as FormData;
}

/** Upload a file into the required answers card and return it. */
async function chooseAnswers() {
  const file = new File(["x"], "answers.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  await userEvent.upload(
    screen.getByLabelText("Ответы пользователей — выбрать файл") as HTMLInputElement,
    file,
  );
  return file;
}

describe("NewAnalysis — layout", () => {
  it("renders the title, subtitle and the two upload cards", () => {
    renderScreen();
    expect(
      screen.getByRole("heading", { level: 1, name: "Анализ результатов тестов" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Загрузите ответы пользователей и запустите анализ")).toBeInTheDocument();

    expect(screen.getByRole("heading", { name: "Ответы пользователей" })).toBeInTheDocument();
    expect(screen.getByText("Обязательно · .xlsx или .csv, несколько групп")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Эталонные ответы" })).toBeInTheDocument();
    expect(screen.getByText("Рекомендуется · один файл на все группы")).toBeInTheDocument();

    // Answers card allows several files ("файлы"); reference stays single ("файл").
    expect(screen.getByText("Перетащите файлы сюда или нажмите для выбора")).toBeInTheDocument();
    expect(screen.getByText("Перетащите файл сюда или нажмите для выбора")).toBeInTheDocument();
    expect(screen.getAllByText(/Формат: \.xlsx или \.csv, до 50 МБ/)).toHaveLength(2);
  });

  it("lists the four AI capabilities and the chat CTA", () => {
    renderScreen();
    const sidebar = screen.getByRole("complementary", { name: "Что анализирует ИИ" });
    expect(
      within(sidebar).getByRole("heading", { name: "Что анализирует ИИ" }),
    ).toBeInTheDocument();
    for (const title of [
      "Вопросы с низкой долей верных",
      "Частые ошибки",
      "Брошенные попытки",
      "Рекомендации",
    ]) {
      expect(within(sidebar).getByText(title)).toBeInTheDocument();
    }
    const cta = within(sidebar).getByRole("link", { name: "Откройте чат с агентом" });
    expect(cta).toHaveAttribute("href", "/chat");
  });

  it("has no analysis-parameters block any more: only uploads, run and reset", () => {
    renderScreen();
    expect(screen.queryByRole("heading", { name: "Параметры анализа" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Группа нейросетей")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Глубокий анализ с ИИ" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Максимум обращений к ИИ")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Что анализировать" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Запустить анализ/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сбросить" })).toBeInTheDocument();
  });

  it("shows what the run will use under the button, linking to the settings", async () => {
    stubApi({ defaults: { max_llm_calls: 120 } });
    renderScreen();
    const line = screen.getByTestId("analysis-summary");
    // built-in defaults first (Ultra, 500), then the saved ones
    expect(line).toHaveTextContent("GigaChat Ultra · до 500 обращений к ИИ · изменить в настройках");
    await waitFor(() => expect(line).toHaveTextContent("GigaChat Ultra · до 120 обращений к ИИ"));
    expect(within(line).getByRole("link", { name: "изменить в настройках" })).toHaveAttribute("href", "/settings");
  });

  it("says so when the AI is switched off in the settings", async () => {
    stubApi({ defaults: { deep: false } });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId("analysis-summary")).toHaveTextContent("ИИ выключен"));
  });

  it("keeps Запустить анализ disabled until a required file is chosen", async () => {
    renderScreen();
    const run = screen.getByRole("button", { name: /Запустить анализ/ });
    expect(run).toBeDisabled();

    await chooseAnswers();
    expect(screen.getByText("answers.xlsx")).toBeInTheDocument();
    expect(run).toBeEnabled();
  });

  it("«Сбросить» clears the chosen files", async () => {
    renderScreen();
    await chooseAnswers();
    expect(screen.getByText("answers.xlsx")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    expect(screen.queryByText("answers.xlsx")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Запустить анализ/ })).toBeDisabled();
  });

  it("scopes file inputs per card via their accessible labels", () => {
    renderScreen();
    const answers = screen.getByLabelText("Ответы пользователей — выбрать файл");
    const reference = screen.getByLabelText("Эталонные ответы — выбрать файл");
    expect(answers).not.toBe(reference);
    expect(within(answers.closest("section") as HTMLElement)).toBeTruthy();
  });
});

describe("NewAnalysis — /analyze wiring", () => {
  it("POSTs multipart to /analyze with the saved defaults and navigates to /results?run=<id>", async () => {
    const fetchMock = stubApi({ analyze: jsonResponse({ run_id: "20260624-120000-abc123" }) });

    renderScreen();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/settings", expect.anything()));
    await chooseAnswers();
    await userEvent.click(screen.getByRole("button", { name: /Запустить анализ/ }));

    // Navigated to the Результаты tab with the run id as a query param.
    await waitFor(() =>
      expect(screen.getByTestId("results-probe")).toHaveTextContent(
        "/results?run=20260624-120000-abc123",
      ),
    );

    const call = fetchMock.mock.calls.find((c) => c[0] === "/analyze") as unknown as [string, RequestInit];
    expect(call[1].method).toBe("POST");
    const form = analyzeForm(fetchMock);
    expect(form).toBeInstanceOf(FormData);
    expect((form.get("answers") as File).name).toBe("answers.xlsx");
    expect(form.get("model_group")).toBe("russian");
    // All four aspects -> all-mode + all four insight blocks + insights on, 500 calls.
    expect(form.get("mode")).toBe("all");
    expect(form.get("use_insights")).toBe("true");
    expect(form.getAll("insight_blocks").sort()).toEqual(
      ["anomalies", "diagnosis", "recommendations", "why_failed"],
    );
    expect(form.get("max_llm_calls")).toBe("500");
  });

  it("uses the group, call limit and aspects saved in the settings", async () => {
    const fetchMock = stubApi({
      defaults: { model_group: "foreign", max_llm_calls: 120, aspects: ["recommendations"] },
    });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId("analysis-summary")).toHaveTextContent("до 120"));
    await chooseAnswers();
    await userEvent.click(screen.getByRole("button", { name: /Запустить анализ/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === "/analyze")).toBe(true));
    const form = analyzeForm(fetchMock);
    expect(form.get("model_group")).toBe("foreign");
    expect(form.get("max_llm_calls")).toBe("120");
    expect(form.getAll("insight_blocks")).toEqual(["recommendations"]);
    expect(form.get("mode")).toBe("answer");
  });

  it("sends max_llm_calls=0 and no insights when the AI is off in the settings", async () => {
    const fetchMock = stubApi({ defaults: { deep: false } });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId("analysis-summary")).toHaveTextContent("ИИ выключен"));
    await chooseAnswers();
    await userEvent.click(screen.getByRole("button", { name: /Запустить анализ/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === "/analyze")).toBe(true));
    const form = analyzeForm(fetchMock);
    expect(form.get("max_llm_calls")).toBe("0");
    expect(form.get("use_insights")).toBe("false");
  });

  it("with no aspect saved still requests insights with all blocks (the switch is the master, #15)", async () => {
    const fetchMock = stubApi({ defaults: { aspects: [] } });
    renderScreen();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await chooseAnswers();
    await userEvent.click(screen.getByRole("button", { name: /Запустить анализ/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === "/analyze")).toBe(true));
    const form = analyzeForm(fetchMock);
    expect(form.get("use_insights")).toBe("true");
    expect(form.getAll("insight_blocks").sort()).toEqual(
      ["anomalies", "diagnosis", "recommendations", "why_failed"],
    );
  });

  it("shows the Russian error from the backend and does not navigate on failure", async () => {
    stubApi({ analyze: jsonResponse({ detail: "Ошибка анализа: нет ключа API." }, false, 400) });

    renderScreen();
    await chooseAnswers();
    await userEvent.click(screen.getByRole("button", { name: /Запустить анализ/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Ошибка анализа: нет ключа API.");
    expect(screen.queryByTestId("results-probe")).not.toBeInTheDocument();
    // The button is re-enabled so the user can retry.
    expect(screen.getByRole("button", { name: /Запустить анализ/ })).toBeEnabled();
  });

  it("shows a Russian fallback when the result carries an error field", async () => {
    stubApi({ analyze: jsonResponse({ error: "Не найдено корректных файлов .xlsx." }) });

    renderScreen();
    await chooseAnswers();
    await userEvent.click(screen.getByRole("button", { name: /Запустить анализ/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Не найдено корректных файлов .xlsx.",
    );
    expect(screen.queryByTestId("results-probe")).not.toBeInTheDocument();
  });
});

describe("NewAnalysis — usability fixes", () => {
  it("explains that the reference is optional and the analysis can run without it", () => {
    renderScreen();
    expect(screen.getByText(/Можно запустить и без эталона/)).toBeInTheDocument();
  });

  it("flags an unsupported file before the run and does not enable the button for it", async () => {
    renderScreen();
    const bad = new File(["x"], "notes.txt", { type: "text/plain" });
    await userEvent.upload(
      screen.getByLabelText("Ответы пользователей — выбрать файл") as HTMLInputElement,
      bad,
      { applyAccept: false },
    );
    expect(screen.getAllByText("не поддерживается").length).toBeGreaterThan(0);
    expect(screen.getByRole("status")).toHaveTextContent("«notes.txt»");
    expect(screen.getByRole("button", { name: /Запустить анализ/ })).toBeDisabled();
  });

  it("shows a progress panel with elapsed time and a cancel button while running", async () => {
    let release: (r: Response) => void = () => {};
    stubApi({ analyze: () => new Promise<Response>((resolve) => (release = resolve)) });
    renderScreen();
    await chooseAnswers();
    await userEvent.click(screen.getByRole("button", { name: /Запустить анализ/ }));
    const panel = await screen.findByRole("status", { name: "Ход анализа" });
    expect(panel).toHaveTextContent("Идёт анализ");
    expect(within(panel).getByRole("button", { name: "Отмена" })).toBeInTheDocument();
    release(jsonResponse({ run_id: "r1" }));
    await waitFor(() => expect(screen.getByTestId("results-probe")).toBeInTheDocument());
  });
});
