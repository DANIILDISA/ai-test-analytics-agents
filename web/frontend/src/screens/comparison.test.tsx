// web/frontend/src/screens/comparison.test.tsx
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { Comparison } from "@/screens/Comparison";

// Recharts' ResponsiveContainer measures its parent via ResizeObserver and renders
// nothing at 0×0 in jsdom. Stub ResizeObserver and give the container a real size so
// the charts mount; we assert on the screen's structure, not the chart internals.
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

// --- Fixtures: a /runs index + the /compare diff (compute_diff shape). ---------------

const ID_A = "20260514-100000-aaaaaa";
const ID_B = "20260528-100000-bbbbbb";

function runMeta(id: string, createdAt: string, summary: Record<string, unknown>) {
  return {
    id,
    created_at: createdAt,
    name: id === ID_A ? "Группа А–12.xlsx" : "Группа Б–07.xlsx",
    course_id: "Управление проектами",
    model_group: "foreign",
    mode: "all",
    summary,
  };
}

const RUN_INDEX = [
  runMeta(ID_B, "2026-05-28 10:00:00", { total_users: 98, total_questions: 50, avg_score: 69, critical: 15 }),
  runMeta(ID_A, "2026-05-14 10:00:00", { total_users: 124, total_questions: 50, avg_score: 78, critical: 8 }),
];

// POST /compare → agents.insight_agent.compute_diff(result_a, result_b).
const DIFF = {
  course_a: "Управление проектами",
  course_b: "Управление проектами",
  summary_a: { total_users: 124, total_questions: 50, avg_score: 78, real_attempts: 162, abandoned: 28 },
  summary_b: { total_users: 98, total_questions: 50, avg_score: 69, real_attempts: 118, abandoned: 36 },
  summary_delta: { avg_score: -9, total_users: -26, critical: 7 },
  common_count: 50,
  stable_count: 40,
  improved: [
    { question_text: "Вопрос про этапы процесса", a_rate: 0.5, b_rate: 0.7, delta: 0.2 },
  ],
  worsened: [
    { question_text: "Вопрос про терминологию проекта", a_rate: 0.8, b_rate: 0.55, delta: -0.25 },
    { question_text: "Кейсовое задание по рискам", a_rate: 0.7, b_rate: 0.5, delta: -0.2 },
  ],
  new: [],
  dropped: [],
};

/** Fake `fetch` routing GET /runs, POST /compare; records POST /threads bodies. */
function stubFetch(opts?: { runs?: unknown[]; diff?: unknown; compareStatus?: number }) {
  const runs = opts?.runs ?? RUN_INDEX;
  const diff = opts?.diff ?? DIFF;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/runs") return { ok: true, status: 200, json: async () => runs } as Response;
    if (url === "/compare") {
      if (opts?.compareStatus && opts.compareStatus >= 400) {
        return {
          ok: false,
          status: opts.compareStatus,
          json: async () => ({ detail: "Анализ не найден: X" }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => diff } as Response;
    }
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

function renderScreen(initialUrl = "/compare") {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <Routes>
        <Route path="/compare" element={<Comparison />} />
        <Route path="/chat" element={<ChatProbe />} />
        <Route path="/history" element={<div data-testid="history-probe" />} />
        <Route path="/" element={<div data-testid="home-probe" />} />
      </Routes>
    </MemoryRouter>,
  );
}

const COMPARE_URL = `/compare?a=${ID_A}&b=${ID_B}`;

describe("Comparison — loading", () => {
  it("POSTs /compare with the a/b ids from the URL", async () => {
    const fetchMock = stubFetch();
    renderScreen(COMPARE_URL);

    await screen.findByRole("region", { name: "Заголовки анализов" });
    const compareCall = fetchMock.mock.calls.find((c) => c[0] === "/compare");
    expect(compareCall).toBeDefined();
    const body = JSON.parse(String((compareCall![1] as RequestInit).body));
    expect(body).toEqual({ run_id_a: ID_A, run_id_b: ID_B });
  });

  it("shows the empty state when there are no runs", async () => {
    stubFetch({ runs: [] });
    renderScreen(COMPARE_URL);
    expect(await screen.findByText("Пока нечего сравнивать")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Заголовки анализов" })).not.toBeInTheDocument();
  });

  it("shows the picker when a/b are not both in the URL", async () => {
    stubFetch();
    renderScreen("/compare");
    expect(
      await screen.findByRole("region", { name: "Выбор анализов для сравнения" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Раньше" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Позже" })).toBeInTheDocument();
  });

  it("shows an error state when /compare fails", async () => {
    stubFetch({ compareStatus: 404 });
    renderScreen(COMPARE_URL);
    expect(await screen.findByText("Не удалось построить сравнение")).toBeInTheDocument();
  });
});

describe("Comparison — real data rendering", () => {
  it("renders the title and subtitle", async () => {
    stubFetch();
    renderScreen(COMPARE_URL);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Сравнение анализов" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Сопоставьте два анализа/)).toBeInTheDocument();
  });

  it("renders the two group header cards from the run meta (course + date)", async () => {
    stubFetch();
    renderScreen(COMPARE_URL);
    const headers = await screen.findByRole("region", { name: "Заголовки анализов" });
    expect(within(headers).getByRole("heading", { name: "Раньше" })).toBeInTheDocument();
    expect(within(headers).getByRole("heading", { name: "Позже" })).toBeInTheDocument();
    // Dates come from each run's created_at (DD.MM.YYYY HH:MM).
    expect(within(headers).getByText("14.05.2026 10:00")).toBeInTheDocument();
    expect(within(headers).getByText("28.05.2026 10:00")).toBeInTheDocument();
    // The fake hardcoded «Базовый анализ» badge is gone (depth data isn't available here).
    expect(screen.queryByText("Базовый анализ")).not.toBeInTheDocument();
  });

  it("renders the summary table with real values and the avg-score change", async () => {
    stubFetch();
    renderScreen(COMPARE_URL);
    const table = await screen.findByRole("region", { name: "Сводные показатели" });
    for (const col of ["Метрика", "Раньше", "Позже", "Изменение"]) {
      expect(within(table).getByRole("columnheader", { name: col })).toBeInTheDocument();
    }
    // total_users 124 / 98, avg_score 78% / 69%.
    expect(within(table).getByText("124")).toBeInTheDocument();
    expect(within(table).getByText("98")).toBeInTheDocument();
    expect(within(table).getByText("78%")).toBeInTheDocument();
    expect(within(table).getByText("69%")).toBeInTheDocument();
    // summary_delta.avg_score = −9 → "−9 п.п." change cell.
    expect(within(table).getByText("−9 п.п.")).toBeInTheDocument();
    // Critical counts come from the run-meta index (8 → 15).
    expect(within(table).getByText("Критические вопросы")).toBeInTheDocument();
  });

  it("renders the key-directions panel with the average-score bars", async () => {
    stubFetch();
    renderScreen(COMPARE_URL);
    const panel = await screen.findByRole("region", {
      name: "Сравнение по ключевым направлениям",
    });
    expect(within(panel).getByText("Средний балл")).toBeInTheDocument();
    expect(within(panel).getByText("Количество критических вопросов")).toBeInTheDocument();
    expect(
      within(panel).getByLabelText(/Средний балл: Раньше 78%, Позже 69%/),
    ).toBeInTheDocument();
  });

  it("renders the automatic-conclusions card from the diff (not labelled as AI)", async () => {
    stubFetch();
    renderScreen(COMPARE_URL);
    const ai = await screen.findByRole("region", { name: "Автоматические выводы по сравнению" });
    expect(within(ai).getByRole("heading", { name: "Ключевое различие" })).toBeInTheDocument();
    expect(within(ai).getByRole("heading", { name: "Вывод" })).toBeInTheDocument();
  });

  it("renders the detailed metrics table from improved/worsened questions", async () => {
    stubFetch();
    renderScreen(COMPARE_URL);
    const table = await screen.findByRole("region", { name: "Детальное сравнение метрик" });
    for (const col of ["Метрика", "Раньше", "Позже", "Изменение", "Комментарий"]) {
      expect(within(table).getByRole("columnheader", { name: col })).toBeInTheDocument();
    }
    // The worsened question (−25 п.п.) appears as a metric row.
    expect(within(table).getByText("Вопрос про терминологию проекта")).toBeInTheDocument();
    expect(within(table).getByText("−25 п.п.")).toBeInTheDocument();
  });

  it("renders the next-steps list", async () => {
    stubFetch();
    renderScreen(COMPARE_URL);
    const steps = await screen.findByRole("region", { name: "Что сделать методисту дальше" });
    expect(within(steps).getAllByRole("listitem").length).toBeGreaterThan(0);
  });
});

describe("Comparison — actions", () => {
  it("shows only working controls: no «Сохранить» / «Экспорт» stubs", async () => {
    stubFetch();
    renderScreen(COMPARE_URL);
    expect(await screen.findByRole("button", { name: /Обсудить сравнение в чате/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Сохранить сравнение/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Экспорт отчёта/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/в разработке/)).not.toBeInTheDocument();
  });

  it("binds a thread to the two runs and opens /chat from «Обсудить сравнение»", async () => {
    const fetchMock = stubFetch();
    renderScreen(COMPARE_URL);

    await userEvent.click(
      await screen.findByRole("button", { name: /Обсудить сравнение в чате/ }),
    );
    await waitFor(() => expect(screen.getByTestId("chat-probe")).toBeInTheDocument());

    const threadCall = fetchMock.mock.calls.find((c) => c[0] === "/threads");
    expect(threadCall).toBeDefined();
    const body = JSON.parse(String((threadCall![1] as RequestInit).body));
    expect(body.category).toBe("Сравнение");
    expect(body.context).toEqual({ compare: [ID_A, ID_B] });
  });

  it("starts a comparison from the picker by writing a/b into the URL", async () => {
    const fetchMock = stubFetch();
    renderScreen("/compare");

    await screen.findByRole("region", { name: "Выбор анализов для сравнения" });
    // Defaults: «Позже» = the newest run, «Раньше» = the previous run of the SAME course.
    await userEvent.click(screen.getByRole("button", { name: /^Сравнить$/ }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => c[0] === "/compare")).toBe(true),
    );
    const compareCall = fetchMock.mock.calls.find((c) => c[0] === "/compare");
    const body = JSON.parse(String((compareCall![1] as RequestInit).body));
    // earlier = ID_A, later = ID_B (both belong to the same course).
    expect(body).toEqual({ run_id_a: ID_A, run_id_b: ID_B });
  });
});

describe("Comparison — protection from meaningless pairs", () => {
  const OTHER = { ...DIFF, same_course: false, comparable: false, common_count: 0, improved: [], worsened: [] };

  it("warns about different courses and shows no «лучше / хуже» verdicts", async () => {
    stubFetch({ diff: OTHER });
    renderScreen(COMPARE_URL);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Эти анализы нельзя сравнивать как динамику");
    expect(screen.queryByText(/лучше по среднему баллу/)).not.toBeInTheDocument();
    expect(screen.queryByText("Положительная динамика")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Сравнение невозможно" })).toBeInTheDocument();
  });

  it("does not offer the same analysis twice in the picker", async () => {
    stubFetch();
    renderScreen("/compare");
    await screen.findByRole("region", { name: "Выбор анализов для сравнения" });
    const earlier = screen.getByRole("combobox", { name: "Раньше" });
    // the option selected as «Позже» is disabled in «Раньше»
    const disabled = within(earlier).getAllByRole("option").filter((o) => (o as HTMLOptionElement).disabled);
    expect(disabled).toHaveLength(1);
  });
});
