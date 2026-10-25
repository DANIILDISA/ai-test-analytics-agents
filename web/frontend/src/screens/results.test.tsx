// web/frontend/src/screens/results.test.tsx
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { Results } from "@/screens/Results";

// Recharts' ResponsiveContainer measures its parent via ResizeObserver and renders
// nothing at 0×0 in jsdom. Stub ResizeObserver and give the container a real size so
// the chart mounts; we assert on the screen's structure, not the chart internals.
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(480);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(160);
});

afterEach(() => vi.restoreAllMocks());

// --- Fixtures: a run-index entry + a full saved run (web/service.run_analysis shape). --

const RUN_ID = "20260624-114229-b23180";

function runMeta(id: string, summary: Record<string, unknown>) {
  return {
    id,
    created_at: "2026-06-24 11:42:29",
    name: "массив.xlsx",
    course_id: "анализ",
    model_group: "foreign",
    mode: "all",
    summary,
  };
}

const RUN_INDEX = [
  runMeta(RUN_ID, { total_users: 45, total_questions: 50, avg_score: 70, critical: 2 }),
  // Prior run drives the deltas (newest-first index, so this is the previous analysis).
  runMeta("20260623-100000-aaaaaa", { total_users: 40, total_questions: 50, avg_score: 76, critical: 1 }),
];

const RUN_RESULT = {
  course_id: "анализ",
  answer: {
    summary: {
      total_users: 45,
      total_questions: 50,
      avg_score: 70,
      real_attempts: 380,
      abandoned: 120,
    },
    questions: [
      {
        question_text: "Слабый вопрос про план-график",
        correct_rate: 0.14,
        critical: true,
        common_errors: [
          { answer: "все варианты верны", count: 43 },
          { answer: "при изменении способа", count: 4 },
        ],
      },
      {
        question_text: "Вопрос про малые закупки",
        correct_rate: 0.29,
        critical: true,
        common_errors: [{ answer: "по п. 4 части 1 ст. 93", count: 30 }],
      },
      {
        question_text: "Нормальный вопрос",
        correct_rate: 0.9,
        critical: false,
        common_errors: [],
      },
    ],
  },
  time: {
    note: "нет времени на вопрос",
    tests: [
      { test_name: "Тест 1", attempts: 16, median_score: 70 },
      { test_name: "Тест 2", attempts: 19, median_score: 33.3 },
      { test_name: "Тест 3", attempts: 16, median_score: 86.7 },
    ],
    attempt_anomalies: [{ student_id: "s1" }, { student_id: "s2" }],
    abandoned_rate: 24,
  },
  insights: {
    commentary: {
      blocks: {
        diagnosis: "Средний балл 70% ниже целевого.\nДва критических вопроса высокого риска.",
        recommendations: "Переработать критические вопросы.\nДобавить практические примеры.",
      },
      custom: null,
    },
    suggestions: {
      gaps: [{ code: "low_samples", severity: "medium", message: "28 вопрос(ов) имеют мало ответов" }],
      narrative: null,
    },
  },
  warnings: [],
};

/** Fake `fetch` routing GET /runs and GET /runs/:id; records POST /threads bodies. */
function stubFetch(opts?: { runs?: unknown[]; run?: unknown }) {
  const runs = opts?.runs ?? RUN_INDEX;
  const run = opts?.run ?? RUN_RESULT;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/runs") return { ok: true, status: 200, json: async () => runs } as Response;
    if (url.startsWith("/runs/")) return { ok: true, status: 200, json: async () => run } as Response;
    if (url === "/threads")
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "t-new", ...JSON.parse(String(init?.body ?? "{}")) }),
      } as Response;
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function ChatProbe() {
  const loc = useLocation();
  return <div data-testid="chat-probe">{`${loc.pathname}${loc.search}`}</div>;
}

function renderScreen(initialUrl = "/results") {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <Routes>
        <Route path="/results" element={<Results />} />
        <Route path="/chat" element={<ChatProbe />} />
        <Route path="/" element={<div data-testid="home-probe" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Results — run loading", () => {
  it("loads the latest run when no ?run is given and renders the header + banner", async () => {
    const fetchMock = stubFetch();
    renderScreen("/results");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Результаты анализа" }),
    ).toBeInTheDocument();
    // No ?run → first GET /runs, then GET /runs/<latest id>.
    expect(fetchMock).toHaveBeenCalledWith("/runs", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenCalledWith(`/runs/${RUN_ID}`, expect.objectContaining({ method: "GET" }));

    // avg_score 70 < 75 and 2 critical → the warning banner shows.
    const banner = screen.getByRole("alert");
    expect(within(banner).getByText("Курс требует внимания")).toBeInTheDocument();
  });

  it("loads the run named in ?run=<id>", async () => {
    const fetchMock = stubFetch();
    renderScreen(`/results?run=${RUN_ID}`);
    await screen.findByRole("region", { name: "Ключевые метрики" });
    expect(fetchMock).toHaveBeenCalledWith(`/runs/${RUN_ID}`, expect.objectContaining({ method: "GET" }));
  });

  it("shows the empty state when there are no runs", async () => {
    stubFetch({ runs: [] });
    renderScreen("/results");
    expect(await screen.findByText("Пока нет ни одного анализа")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Ключевые метрики" })).not.toBeInTheDocument();
  });

  it("shows an error state when the run fails to load", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/runs") return { ok: true, status: 200, json: async () => RUN_INDEX } as Response;
      return { ok: false, status: 404, json: async () => ({ detail: "Анализ не найден." }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    renderScreen("/results");
    expect(await screen.findByText("Не удалось загрузить анализ")).toBeInTheDocument();
  });
});

describe("Results — real data rendering", () => {
  it("renders metric cards from answer.summary with deltas vs the prior run", async () => {
    stubFetch();
    renderScreen("/results");
    const metrics = await screen.findByRole("region", { name: "Ключевые метрики" });

    expect(within(metrics).getByText("Пользователи")).toBeInTheDocument();
    expect(within(metrics).getByText("45")).toBeInTheDocument(); // total_users
    expect(within(metrics).getByText("70%")).toBeInTheDocument(); // avg_score
    expect(within(metrics).getByText("380")).toBeInTheDocument(); // real_attempts
    expect(within(metrics).getByText("2")).toBeInTheDocument(); // critical count

    // Deltas vs prior: users 45-40 = +5; avg 70-76 = −6 п.п.
    expect(within(metrics).getByText("+5 к прошлому анализу")).toBeInTheDocument();
    expect(within(metrics).getByText("−6 п.п. к прошлому анализу")).toBeInTheDocument();
  });

  it("renders ИИ-выводы from insights.commentary blocks", async () => {
    stubFetch();
    renderScreen("/results");
    const section = await screen.findByRole("region", { name: "ИИ-выводы" });
    expect(within(section).getByRole("heading", { name: "Коротко о результатах" })).toBeInTheDocument();
    expect(within(section).getByRole("heading", { name: "Рекомендации" })).toBeInTheDocument();
    expect(within(section).getByText("Добавить практические примеры.")).toBeInTheDocument();
  });

  it("renders the critical-questions table (critical only, hardest first)", async () => {
    stubFetch();
    renderScreen("/results");
    const table = await screen.findByRole("region", { name: "Критические вопросы" });
    for (const col of ["Доля верных", "Вопрос", "Частые ошибки", "Риск", "Рекомендация"]) {
      expect(within(table).getByRole("columnheader", { name: col })).toBeInTheDocument();
    }
    // Two critical questions (+ header row); the non-critical one is excluded.
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("14%")).toBeInTheDocument(); // hardest, first
    expect(within(table).getByText("Всего критических вопросов: 2")).toBeInTheDocument();
    expect(within(table).queryByText("Нормальный вопрос")).not.toBeInTheDocument();
  });

  it("renders the attempts panel from the time block", async () => {
    stubFetch();
    renderScreen("/results");
    const panel = await screen.findByRole("region", { name: "Анализ попыток" });
    expect(within(panel).getByText("Слушатели с необычным ходом попыток")).toBeInTheDocument();
    expect(within(panel).getByText("2 из 45")).toBeInTheDocument(); // anomalies out of all listeners
    expect(within(panel).getByText("Завершили")).toBeInTheDocument();
    expect(within(panel).getByText("Распределение долей верных ответов по вопросам")).toBeInTheDocument();
    expect(within(panel).getByLabelText("Распределение баллов — гистограмма")).toBeInTheDocument();
  });

  it("expands the text report built from the insights", async () => {
    stubFetch();
    renderScreen("/results");
    const toggle = await screen.findByRole("button", { name: /Текстовый отчёт/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    // The suggestion gap appears only in the expanded report body, so it is unambiguous.
    expect(screen.getByText(/28 вопрос\(ов\) имеют мало ответов/)).toBeInTheDocument();
  });
});

describe("Results — honest AI-off copy (FIX-2)", () => {
  // Same run, but with no AI insights (free/code mode, max_llm_calls=0 → nothing ran).
  const RUN_RESULT_NO_AI = { ...RUN_RESULT, insights: undefined };

  it("uses a neutral subtitle + «выключен» notice when no AI insights are present", async () => {
    stubFetch({ run: RUN_RESULT_NO_AI });
    renderScreen("/results");

    // Subtitle is adaptive: no insights → neutral «Расчёт по данным…», never the false «ИИ обработал…» claim.
    expect(
      await screen.findByText(/^Расчёт по данным тестирования/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^ИИ обработал данные тестирования/)).not.toBeInTheDocument();

    // The ИИ-выводы notice states the toggle was OFF (not a "no data / failed" error).
    const section = screen.getByRole("region", { name: "ИИ-выводы" });
    expect(within(section).getByText(/Глубокий анализ с ИИ был выключен/)).toBeInTheDocument();
  });

  it("keeps the «ИИ обработал…» subtitle when AI insights are present", async () => {
    stubFetch(); // default RUN_RESULT carries insights.commentary blocks
    renderScreen("/results");

    expect(
      await screen.findByText(/^ИИ обработал данные тестирования/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/^Расчёт по данным тестирования/),
    ).not.toBeInTheDocument();
  });
});

describe("Results — ask the agent and download", () => {
  it("«Уточнить у агента» is a button in the header: binds a thread to the run and opens /chat", async () => {
    const fetchMock = stubFetch();
    renderScreen(`/results?run=${RUN_ID}`);

    const actions = await screen.findByRole("group", { name: "Действия с результатами" });
    await userEvent.click(within(actions).getByRole("button", { name: "Уточнить у агента" }));

    await waitFor(() => expect(screen.getByTestId("chat-probe")).toBeInTheDocument());

    // A thread was created with the run bound into its context.
    const threadCall = fetchMock.mock.calls.find((c) => c[0] === "/threads");
    expect(threadCall).toBeDefined();
    const init = threadCall![1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.context).toEqual({ run_id: RUN_ID });
  });

  it("no longer renders the old «Уточнить у агента» card next to the insights", async () => {
    stubFetch();
    renderScreen(`/results?run=${RUN_ID}`);
    await screen.findByRole("group", { name: "Действия с результатами" });
    expect(screen.queryByRole("complementary", { name: "Уточнить у агента" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Спросить ИИ про результаты/)).not.toBeInTheDocument();
  });

  it("has «Скачать Word» and «Скачать PDF» at the top that fetch the run's report", async () => {
    const base = stubFetch();
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      url.startsWith("/download/")
        ? Promise.resolve({
            ok: true,
            status: 200,
            blob: async () => new Blob(["x"]),
            headers: new Headers(),
          } as Response)
        : base(url, init),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    URL.createObjectURL = vi.fn(() => "blob:report");
    URL.revokeObjectURL = vi.fn();
    renderScreen(`/results?run=${RUN_ID}`);

    await userEvent.click(await screen.findByRole("button", { name: "Скачать Word" }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === `/download/${RUN_ID}.docx`)).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Скачать PDF" }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === `/download/${RUN_ID}.pdf`)).toBe(true));
  });

  it("shows the Russian failure text when the PDF cannot be produced", async () => {
    const base = stubFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) =>
        url.startsWith("/download/") ? Promise.resolve({ ok: false, status: 500 } as Response) : base(url, init),
      ),
    );
    renderScreen(`/results?run=${RUN_ID}`);
    await userEvent.click(await screen.findByRole("button", { name: "Скачать PDF" }));
    expect(await screen.findByText(/Не удалось сформировать PDF/)).toBeInTheDocument();
  });
});

describe("Results — ИИ-выводы layout", () => {
  const FULL = {
    ...RUN_RESULT,
    insights: {
      commentary: {
        blocks: {
          anomalies: "- риск один\n- риск два",
          recommendations: "1) Переписать вопрос.\n2) Добавить подсказку.",
          why_failed: "- путают понятия",
          diagnosis: "Тест сдан **удовлетворительно**, но есть пробелы.",
        },
        custom: null,
      },
      suggestions: { gaps: [], narrative: null },
    },
  };

  it("stacks the four blocks vertically in the fixed order and titles, whatever the order in the data", async () => {
    stubFetch({ run: FULL });
    renderScreen("/results");
    const section = await screen.findByRole("region", { name: "ИИ-выводы" });
    const titles = within(section).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual([
      "Коротко о результатах",
      "Почему вопросы провалены",
      "Рекомендации",
      "Аномалии и риски",
    ]);
  });

  it("renders list lines as bullets and prose as a paragraph (markdown marks dropped)", async () => {
    stubFetch({ run: FULL });
    renderScreen("/results");
    const section = await screen.findByRole("region", { name: "ИИ-выводы" });
    expect(within(section).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "путают понятия",
      "Переписать вопрос.",
      "Добавить подсказку.",
      "риск один",
      "риск два",
    ]);
    expect(within(section).getByText("Тест сдан удовлетворительно, но есть пробелы.")).toBeInTheDocument();
  });
});

describe("Results — usability fixes", () => {
  it("names the analysis in a descriptor line and lets the user switch analyses", async () => {
    stubFetch({
      runs: [
        { ...runMeta(RUN_ID, { total_users: 45 }), course_id: "ЭК 069", name: "ЭК 069, 10.10.2026 00:40", groups: ["Группа 1"] },
        { ...runMeta("old-1", { total_users: 40 }), course_id: "ЭК 112", name: "ЭК 112, 09.10.2026 10:00" },
      ],
      run: { ...RUN_RESULT, course_id: "ЭК 069" },
    });
    renderScreen("/results");
    const line = await screen.findByTestId("run-descriptor");
    expect(line).toHaveTextContent("ЭК 069");
    expect(line).toHaveTextContent("24.06.2026 11:42");
    expect(screen.getByRole("combobox", { name: "Выбрать анализ" })).toBeInTheDocument();
  });

  it("shows no deltas and says so when there is no earlier analysis of the same course", async () => {
    stubFetch({
      runs: [
        { ...runMeta(RUN_ID, { total_users: 45, total_questions: 50, avg_score: 70, critical: 2 }), course_id: "ЭК 069", name: "A" },
        { ...runMeta("other", { total_users: 40, total_questions: 50, avg_score: 76, critical: 1 }), course_id: "ЭК 112", name: "B" },
      ],
    });
    renderScreen("/results");
    const metrics = await screen.findByRole("region", { name: "Ключевые метрики" });
    expect(within(metrics).queryByText(/к прошлому анализу/)).not.toBeInTheDocument();
    expect(within(metrics).queryByText("без изменений")).not.toBeInTheDocument();
    expect(screen.getByTestId("delta-basis")).toHaveTextContent("Нет предыдущего анализа этого курса");
  });

  it("states which earlier analysis the deltas are computed against", async () => {
    stubFetch();
    renderScreen("/results");
    await screen.findByRole("region", { name: "Ключевые метрики" });
    expect(screen.getByTestId("delta-basis")).toHaveTextContent("Изменения посчитаны к анализу");
  });

  it("warns plainly when some uploaded files could not be used", async () => {
    stubFetch({
      run: {
        ...RUN_RESULT,
        input_report: {
          answer_files: 3,
          answer_files_used: 2,
          groups_total: 3,
          groups_used: 2,
          has_reference: false,
          skipped: [{ file: "группа 3.xlsx", reason: "Файл «группа 3.xlsx» повреждён." }],
          notes: [],
          limitations: ["Эталон не загружен."],
        },
      },
    });
    renderScreen("/results");
    const plate = await screen.findByRole("alert", { name: "Не все данные учтены" });
    expect(plate).toHaveTextContent("Учтено групп: 2 из 3");
    expect(plate).toHaveTextContent("группа 3.xlsx");
  });

  it("shows the correct answer, a per-kind recommendation and the key-error flag", async () => {
    stubFetch({
      run: {
        ...RUN_RESULT,
        answer: {
          ...RUN_RESULT.answer,
          questions: [
            {
              question_text: "Кто автор?",
              correct_rate: 0.1,
              critical: true,
              correct_answer: "Тейлор",
              answered: 100,
              key_suspect: { answer: "Эмерсон", share: 0.88 },
              common_errors: [{ answer: "Эмерсон", count: 88 }],
            },
          ],
        },
      },
    });
    renderScreen("/results");
    const table = await screen.findByRole("region", { name: "Критические вопросы" });
    expect(within(table).getByRole("columnheader", { name: "Правильный ответ" })).toBeInTheDocument();
    expect(within(table).getByText("Тейлор")).toBeInTheDocument();
    expect(within(table).getByText("Возможна ошибка в эталоне")).toBeInTheDocument();
    expect(within(table).getByText(/88% отвечавших/)).toBeInTheDocument();
  });

  it("shows «нет в эталоне» (muted) instead of «не заполнено» when the reference has no correct answer", async () => {
    stubFetch({
      run: {
        ...RUN_RESULT,
        answer: {
          ...RUN_RESULT.answer,
          questions: [
            {
              question_text: "Вопрос без ключа",
              correct_rate: 0.2,
              critical: true,
              correct_answer: "; ; ;",
              answered: 100,
              common_errors: [{ answer: "; ;", count: 5 }],
            },
          ],
        },
      },
    });
    renderScreen("/results");
    const table = await screen.findByRole("region", { name: "Критические вопросы" });
    const missing = within(table).getByText("нет в эталоне");
    expect(missing.className).toMatch(/text-muted-foreground/);
    // «не заполнено» stays only where a LEARNER left the answer empty (frequent errors).
    expect(within(table).getAllByText("не заполнено")).toHaveLength(1);
  });

  it("unpacks an AI reply that was stored as a Python-style list", async () => {
    stubFetch({
      run: {
        ...RUN_RESULT,
        insights: {
          commentary: {
            blocks: { recommendations: "['Перепроверить эталоны', \"Уточнить формулировку\"]" },
            custom: null,
          },
          suggestions: { gaps: [], narrative: null },
        },
      },
    });
    renderScreen("/results");
    const section = await screen.findByRole("region", { name: "ИИ-выводы" });
    expect(within(section).getByText("Перепроверить эталоны")).toBeInTheDocument();
    expect(within(section).getByText("Уточнить формулировку")).toBeInTheDocument();
    expect(section.textContent).not.toContain("['");
  });

  it("builds the text report from data even when the AI was off", async () => {
    stubFetch({ run: { ...RUN_RESULT, insights: undefined } });
    renderScreen("/results");
    await userEvent.click(await screen.findByRole("button", { name: /Текстовый отчёт/ }));
    expect(screen.getByText(/Самые трудные вопросы/)).toBeInTheDocument();
    expect(screen.getAllByText(/Слабый вопрос про план-график/).length).toBeGreaterThan(1);
  });

  it("opens the list of unusual attempt patterns when its card is clicked", async () => {
    stubFetch({
      run: {
        ...RUN_RESULT,
        time: {
          ...RUN_RESULT.time,
          attempt_anomalies: [
            { student_id: "s1", attempts: 6, score_min: 0, score_max: 85, reason: "резкий скачок" },
          ],
        },
      },
    });
    renderScreen("/results");
    const card = await screen.findByRole("button", { name: /Слушатели с необычным ходом попыток/ });
    await userEvent.click(card);
    expect(screen.getByText("резкий скачок")).toBeInTheDocument();
    expect(screen.getByText("s1")).toBeInTheDocument();
  });
});
