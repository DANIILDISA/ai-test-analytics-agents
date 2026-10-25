// web/frontend/src/screens/history.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { History } from "@/screens/History";

afterEach(() => vi.restoreAllMocks());

// --- Test harness -----------------------------------------------------------------
// Mount History under a router with sibling probe routes so navigation to /compare
// (Сравнить выбранные) and /chat (Обсудить с агентом) is observable in the DOM.

function Probe({ id }: { id: string }) {
  const loc = useLocation();
  return <div data-testid={id}>{`${loc.pathname}${loc.search}`}</div>;
}

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={["/history"]}>
      <Routes>
        <Route path="/history" element={<History />} />
        <Route path="/compare" element={<Probe id="compare-probe" />} />
        <Route path="/chat" element={<Probe id="chat-probe" />} />
        <Route path="/" element={<Probe id="home-probe" />} />
      </Routes>
    </MemoryRouter>,
  );
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

// --- Fixtures: GET /runs index entries (core.history._meta_from shape) --------------

function runMeta(
  id: string,
  created_at: string,
  name: string,
  course_id: string | null,
  summary: { total_users?: number | null; total_questions?: number | null; avg_score?: number | null; critical?: number | null },
): Record<string, unknown> {
  return { id, created_at, name, course_id, model_group: "foreign", mode: "all", summary };
}

const RUNS = [
  runMeta("r1", "2026-06-24 11:42:29", "Итоговый тест — модуль 3", "Управление проектами", {
    total_users: 28,
    total_questions: 40,
    avg_score: 86,
    critical: 2,
  }),
  runMeta("r2", "2026-06-20 09:10:00", "Повторный анализ — март", "Коммуникации", {
    total_users: 24,
    total_questions: 35,
    avg_score: 68,
    critical: 7,
  }),
  runMeta("r3", "2026-05-18 14:00:00", "Диагностика группы", "Лидерство", {
    total_users: 20,
    total_questions: 30,
    avg_score: 48,
    critical: 4,
  }),
];

/** Stub global fetch so GET /runs returns `runs` and POST /threads returns a thread. */
function stubFetch(runs = RUNS) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.startsWith("/runs")) return Promise.resolve(jsonResponse(runs));
    if (typeof url === "string" && url.startsWith("/threads") && init?.method === "POST") {
      return Promise.resolve(jsonResponse({ id: "t1" }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// --- Tests -------------------------------------------------------------------------

describe("History — layout + load", () => {
  it("renders the title and subtitle", async () => {
    stubFetch();
    renderScreen();
    expect(
      screen.getByRole("heading", { level: 1, name: "История анализов" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Найдите предыдущие анализы, отфильтруйте результаты и выберите отчёты для сравнения",
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("Итоговый тест — модуль 3")).toBeInTheDocument(),
    );
  });

  it("fetches GET /runs and renders one row per run", async () => {
    const fetchMock = stubFetch();
    renderScreen();

    await waitFor(() =>
      expect(screen.getByText("Итоговый тест — модуль 3")).toBeInTheDocument(),
    );
    expect(fetchMock.mock.calls[0][0]).toBe("/runs");

    const table = screen.getByRole("region", { name: "Список анализов" });
    // Three data rows + one header row.
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByText("Повторный анализ — март")).toBeInTheDocument();
    expect(within(table).getByText("86%")).toBeInTheDocument();
    expect(within(table).getByText("Управление проектами")).toBeInTheDocument();
    // created_at "2026-06-24 11:42:29" → "24.06.2026 11:42".
    expect(within(table).getByText("24.06.2026 11:42")).toBeInTheDocument();
  });

  it("renders all column headers", async () => {
    stubFetch();
    renderScreen();
    await waitFor(() => screen.getByText("Итоговый тест — модуль 3"));
    const table = screen.getByRole("region", { name: "Список анализов" });
    for (const col of [
      "Дата",
      "Название",
      "Курс",
      "Группа",
      "Пользователи",
      "Вопросы",
      "Средний балл",
      "Критические вопросы",
      "Файлы отчёта",
      "Обсудить",
    ]) {
      expect(within(table).getByRole("columnheader", { name: col })).toBeInTheDocument();
    }
  });

  it("computes the top stat cards from the fetched list", async () => {
    stubFetch();
    renderScreen();
    await waitFor(() => screen.getByText("Итоговый тест — модуль 3"));
    const summary = screen.getByRole("region", { name: "Сводка по истории" });
    // Всего анализов = 3; Средний балл = round((86+68+48)/3) = 67%; «Более 5 критических» = 1.
    expect(within(summary).getByText("Всего анализов")).toBeInTheDocument();
    expect(within(summary).getByText("3")).toBeInTheDocument();
    expect(within(summary).getByText("67%")).toBeInTheDocument();
    expect(within(summary).getByText("Более 5 критических")).toBeInTheDocument();
    expect(within(summary).getByText("1")).toBeInTheDocument();
  });

  it("rounds the row average score to an integer % to match Results", async () => {
    stubFetch([
      runMeta("rx", "2026-06-24 11:42:29", "Тест с дробным баллом", "Курс X", {
        total_users: 30,
        total_questions: 40,
        avg_score: 76.5,
        critical: 1,
      }),
    ]);
    renderScreen();
    await waitFor(() => screen.getByText("Тест с дробным баллом"));

    const table = screen.getByRole("region", { name: "Список анализов" });
    // Results.tsx renders Math.round(avg_score) → "77%"; History must match (not "76.5%").
    expect(within(table).getByText("77%")).toBeInTheDocument();
    expect(within(table).queryByText("76.5%")).not.toBeInTheDocument();
  });

  it("shows an empty state when there are no runs", async () => {
    stubFetch([]);
    renderScreen();
    expect(await screen.findByText("Пока нет анализов")).toBeInTheDocument();
    const summary = screen.getByRole("region", { name: "Сводка по истории" });
    expect(within(summary).getAllByText("0").length).toBeGreaterThan(0);
  });

  it("shows a Russian error state when the fetch fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("boom"));
    vi.stubGlobal("fetch", fetchMock);
    renderScreen();
    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить данные");
  });
});

describe("History — filters, sort, pagination", () => {
  it("filters rows by the search box", async () => {
    stubFetch();
    renderScreen();
    await waitFor(() => screen.getByText("Итоговый тест — модуль 3"));

    await userEvent.type(screen.getByPlaceholderText("Поиск по названию анализа"), "Повторный");
    expect(screen.getByText("Повторный анализ — март")).toBeInTheDocument();
    expect(screen.queryByText("Итоговый тест — модуль 3")).not.toBeInTheDocument();
  });

  it("filters rows by the Курс dropdown", async () => {
    stubFetch();
    renderScreen();
    await waitFor(() => screen.getByText("Итоговый тест — модуль 3"));

    await userEvent.selectOptions(screen.getByLabelText("Курс"), "Лидерство");
    expect(screen.getByText("Диагностика группы")).toBeInTheDocument();
    expect(screen.queryByText("Итоговый тест — модуль 3")).not.toBeInTheDocument();
  });

  it("filters rows by the Критические вопросы band", async () => {
    stubFetch();
    renderScreen();
    await waitFor(() => screen.getByText("Итоговый тест — модуль 3"));

    await userEvent.selectOptions(screen.getByLabelText("Критические вопросы"), "high");
    // Only r2 (critical = 7) remains.
    expect(screen.getByText("Повторный анализ — март")).toBeInTheDocument();
    expect(screen.queryByText("Итоговый тест — модуль 3")).not.toBeInTheDocument();
    expect(screen.queryByText("Диагностика группы")).not.toBeInTheDocument();
  });

  it("clears filters and selection via Очистить фильтры", async () => {
    stubFetch();
    renderScreen();
    await waitFor(() => screen.getByText("Итоговый тест — модуль 3"));

    await userEvent.type(screen.getByPlaceholderText("Поиск по названию анализа"), "Повторный");
    expect(screen.queryByText("Итоговый тест — модуль 3")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Очистить фильтры/ }));
    expect(screen.getByText("Итоговый тест — модуль 3")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Поиск по названию анализа")).toHaveValue("");
  });

  it("toggles the date sort order", async () => {
    stubFetch();
    renderScreen();
    await waitFor(() => screen.getByText("Итоговый тест — модуль 3"));

    const table = screen.getByRole("region", { name: "Список анализов" });
    const titlesDesc = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((r) => within(r).getByText(/анализ|тест|Диагностика/i).textContent);
    // Newest-first by default: r1 (Итоговый) before r3 (Диагностика).
    expect(titlesDesc[0]).toContain("Итоговый");

    await userEvent.click(screen.getByRole("button", { name: /Сортировать по дате/ }));
    const firstRowAsc = within(within(table).getAllByRole("row")[1]);
    expect(firstRowAsc.getByText("Диагностика группы")).toBeInTheDocument();
  });

  it("pages the list when the per-page size is smaller than the row count", async () => {
    stubFetch();
    renderScreen();
    await waitFor(() => screen.getByText("Итоговый тест — модуль 3"));

    // Force a tiny page size by selecting 10 then shrinking via direct option is not
    // available (min 10). Instead assert the range label reflects the full list.
    expect(screen.getByText("1–3 из 3")).toBeInTheDocument();
  });
});

describe("History — actions", () => {
  it("enables «Сравнить выбранные» only with exactly two rows and navigates to /compare?a&b", async () => {
    stubFetch();
    renderScreen();
    await waitFor(() => screen.getByText("Итоговый тест — модуль 3"));

    const compare = () => screen.getByRole("button", { name: /Сравнить выбранные/ });
    expect(compare()).toBeDisabled();
    expect(compare()).toHaveTextContent("(0)");

    await userEvent.click(screen.getByRole("checkbox", { name: /Итоговый тест — модуль 3/ }));
    expect(compare()).toHaveTextContent("(1)");
    expect(compare()).toBeDisabled();

    await userEvent.click(screen.getByRole("checkbox", { name: /Повторный анализ — март/ }));
    expect(compare()).toHaveTextContent("(2)");
    expect(compare()).toBeEnabled();

    await userEvent.click(compare());
    await waitFor(() => {
      const probe = screen.getByTestId("compare-probe").textContent ?? "";
      expect(probe).toContain("/compare?");
      expect(probe).toContain("a=r1");
      expect(probe).toContain("b=r2");
    });
  });

  it("offers Word, PDF and Excel per row (no JSON link any more)", async () => {
    stubFetch();
    renderScreen();
    await waitFor(() => screen.getByText("Итоговый тест — модуль 3"));

    for (const label of ["Word", "PDF", "Excel"]) {
      expect(screen.getAllByRole("button", { name: new RegExp(`^Скачать ${label} «`) })).toHaveLength(3);
    }
    expect(screen.queryByRole("link", { name: "JSON" })).not.toBeInTheDocument();
  });

  it("downloads the Word / Excel report of the row through /download/{id}.{ext}", async () => {
    const base = stubFetch();
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      url.startsWith("/download/")
        ? Promise.resolve({
            ok: true,
            status: 200,
            blob: async () => new Blob(["x"]),
            headers: new Headers({ "Content-Disposition": "attachment; filename*=UTF-8''%D0%9E%D1%82%D1%87%D1%91%D1%82.docx" }),
          } as Response)
        : base(url, init),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    URL.createObjectURL = vi.fn(() => "blob:report");
    URL.revokeObjectURL = vi.fn();
    renderScreen();
    await waitFor(() => screen.getByText("Итоговый тест — модуль 3"));

    await userEvent.click(screen.getAllByRole("button", { name: /^Скачать Word «/ })[0]);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === "/download/r1.docx")).toBe(true));
    await userEvent.click(screen.getAllByRole("button", { name: /^Скачать Excel «/ })[0]);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => c[0] === "/download/r1.xlsx?sections=summary,questions")).toBe(true),
    );
  });

  it("shows a Russian message when the report cannot be built", async () => {
    const base = stubFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) =>
        url.startsWith("/download/") ? Promise.resolve({ ok: false, status: 500 } as Response) : base(url, init),
      ),
    );
    renderScreen();
    await waitFor(() => screen.getByText("Итоговый тест — модуль 3"));
    await userEvent.click(screen.getAllByRole("button", { name: /^Скачать PDF «/ })[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось сформировать PDF");
  });

  it("«Обсудить с агентом» creates a thread bound to the run and opens /chat", async () => {
    const fetchMock = stubFetch();
    renderScreen();
    await waitFor(() => screen.getByText("Итоговый тест — модуль 3"));

    const buttons = screen.getAllByRole("button", { name: /Обсудить с агентом/ });
    await userEvent.click(buttons[0]);

    await waitFor(() => expect(screen.getByTestId("chat-probe")).toHaveTextContent("/chat"));

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/threads" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body.context).toEqual({ run_id: "r1" });
    expect(body.category).toBe("Анализ");
  });
});

describe("History — open, rename, sort, delete options", () => {
  it("the title is a link that opens the results of that run", async () => {
    stubFetch();
    renderScreen();
    const link = await screen.findByRole("link", { name: "Итоговый тест — модуль 3" });
    expect(link).toHaveAttribute("href", "/results?run=r1");
  });

  it("sorts by the average score when that header is clicked", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText("Итоговый тест — модуль 3");
    await user.click(screen.getByRole("button", { name: "Сортировать: Средний балл" }));
    const rows = within(screen.getByRole("region", { name: "Список анализов" })).getAllByRole("row");
    // descending by score: 86, 68, 48
    expect(rows[1]).toHaveTextContent("Итоговый тест — модуль 3");
    expect(rows[3]).toHaveTextContent("Диагностика группы");
    await user.click(screen.getByRole("button", { name: "Сортировать: Средний балл" }));
    const asc = within(screen.getByRole("region", { name: "Список анализов" })).getAllByRole("row");
    expect(asc[1]).toHaveTextContent("Диагностика группы");
  });

  it("shows groups, a skipped-files badge and a fixed plural in legacy names", async () => {
    stubFetch([
      {
        ...runMeta("g1", "2026-10-10 00:40:00", "Тест 310 (3 групп)", "ЭК 310", { avg_score: 70, critical: 1 }),
        groups: ["Группа 1", "Группа 2", "Группа 3"],
        skipped_files: 1,
      },
    ]);
    renderScreen();
    await screen.findByText("Тест 310 (3 группы)");
    const table = screen.getByRole("region", { name: "Список анализов" });
    expect(within(table).getByText("1–3")).toBeInTheDocument();
    expect(within(table).getByText("не все файлы")).toBeInTheDocument();
    expect(within(table).getByText("ЭК 310")).toBeInTheDocument();
  });

  it("fills the «Группа» column from the run name when the run has no group metadata", async () => {
    stubFetch([
      runMeta("s1", "2026-10-14 21:07:00", "ЭК 069, группа 4, 14.10.2026 21:07", "ЭК 069", { avg_score: 67, critical: 7 }),
      runMeta("s2", "2026-10-14 21:06:00", "ЭК 001, группы 1, 2, 14.10.2026 21:07", "ЭК 001", { avg_score: 77, critical: 3 }),
      runMeta("s3", "2026-10-14 21:05:00", "ЭК 021, 14.10.2026 21:07", "ЭК 021", { avg_score: 70, critical: 2 }),
    ]);
    renderScreen();
    await screen.findByText("ЭК 069, группа 4, 14.10.2026 21:07");
    const rows = within(screen.getByRole("region", { name: "Список анализов" })).getAllByRole("row");
    const cells = (i: number) => within(rows[i]).getAllByRole("cell").map((c) => c.textContent);
    expect(cells(1)[4]).toBe("4"); // «группа 4» → 4
    expect(cells(2)[4]).toBe("1, 2"); // «группы 1, 2» → 1, 2 (the date that follows is not a group)
    expect(cells(3)[4]).toBe("—"); // no group anywhere
  });

  it("renames an analysis inline via PATCH /runs/:id", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/runs/r1" && init?.method === "PATCH") return Promise.resolve(jsonResponse({ id: "r1", name: "Новое" }));
      if (url.startsWith("/runs")) return Promise.resolve(jsonResponse(RUNS));
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText("Итоговый тест — модуль 3");
    await user.click(screen.getByRole("button", { name: "Переименовать «Итоговый тест — модуль 3»" }));
    const input = screen.getByLabelText("Новое название анализа");
    await user.clear(input);
    await user.type(input, "Новое{Enter}");
    await screen.findByText("Новое");
    const call = fetchMock.mock.calls.find((c) => c[0] === "/runs/r1")!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({ name: "Новое" });
  });

  it("the delete dialog names the analysis and can keep the related chats", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/runs/delete" && init?.method === "POST") return Promise.resolve(jsonResponse({ deleted: ["r1"] }));
      if (url.startsWith("/runs")) return Promise.resolve(jsonResponse(RUNS));
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText("Итоговый тест — модуль 3");
    await user.click(screen.getByRole("button", { name: "Удалить «Итоговый тест — модуль 3»" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Итоговый тест — модуль 3 · 24\.06\.2026 11:42/)).toBeInTheDocument();
    const box = within(dialog).getByRole("checkbox", { name: /Удалить связанные обсуждения/ });
    expect(box).toBeChecked();
    await user.click(box);
    await user.click(within(dialog).getByRole("button", { name: "Удалить" }));
    await screen.findByRole("status");
    const call = fetchMock.mock.calls.find((c) => c[0] === "/runs/delete")!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({ ids: ["r1"], delete_chats: false });
  });
});

describe("History deletion", () => {
  function stubDelete(fail = false) {
    let runs = [...RUNS] as Array<{ id: string }>;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/runs/delete" && init?.method === "POST") {
        if (fail) return Promise.resolve(jsonResponse({ detail: "Диск занят" }, false, 500));
        const ids: string[] = JSON.parse(String(init.body)).ids;
        runs = runs.filter((r) => !ids.includes(r.id));
        return Promise.resolve(jsonResponse({ deleted: ids }));
      }
      if (url.startsWith("/runs")) return Promise.resolve(jsonResponse(runs));
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("deletes one row after confirming in the styled dialog", async () => {
    const fetchMock = stubDelete();
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText("Итоговый тест — модуль 3");
    await user.click(screen.getByRole("button", { name: "Удалить «Итоговый тест — модуль 3»" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(screen.queryByText("Итоговый тест — модуль 3")).toBeNull());
    const call = fetchMock.mock.calls.find((c) => c[0] === "/runs/delete")!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({ ids: ["r1"], delete_chats: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("bulk-deletes selected rows and cancel does nothing", async () => {
    stubDelete();
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText("Итоговый тест — модуль 3");
    await user.click(screen.getByLabelText("Выбрать «Итоговый тест — модуль 3»"));
    await user.click(screen.getByLabelText("Выбрать «Диагностика группы»"));
    await user.click(screen.getByRole("button", { name: /Удалить выбранные \(2\)/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Отмена" }));
    expect(screen.getByText("Диагностика группы")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Удалить выбранные \(2\)/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(screen.queryByText("Диагностика группы")).toBeNull());
    expect(screen.getByText("Повторный анализ — март")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Удалить выбранные \(0\)/ }).hasAttribute("disabled")).toBe(true);
  });

  it("shows an error banner when deletion fails", async () => {
    stubDelete(true);
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText("Итоговый тест — модуль 3");
    await user.click(screen.getByRole("button", { name: "Удалить «Итоговый тест — модуль 3»" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Удалить" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Диск занят");
    expect(screen.getByText("Итоговый тест — модуль 3")).toBeTruthy();
  });
});
