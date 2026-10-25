// web/frontend/src/screens/settings.test.tsx
// Covers the «Минимальные Настройки» wiring: GET /settings hydrates the three
// component rows + per-key status, and Save issues a partial PUT /settings carrying
// ONLY the fields the user changed (the backend deep-merges, web/api.py). Fetch is
// stubbed — no real backend / LLM calls.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "@/screens/Settings";
import type { Settings as SettingsData } from "@/types/chat";

afterEach(() => vi.restoreAllMocks());

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

// --- Fixture: GET /settings (core.settings.ui_view) shape ---------------------------

const VIEW: SettingsData = {
  components: {
    analysis: {
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
      params: { max_tokens: 4000, temperature: 0 },
    },
    insight: {
      provider: "openrouter",
      model: "anthropic/claude-3.5-haiku",
      params: { max_tokens: 4000, temperature: 0 },
    },
    chat_agent: {
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
      params: { effort: "medium", max_tokens: 4000, temperature: 0 },
    },
  },
  keys: {
    OPENROUTER_API_KEY: { set: true, source: "env", preview: "••••cdef" },
    GIGACHAT_CREDENTIALS: { set: false, source: "none", preview: "" },
    GIGACHAT_SCOPE: { set: false, source: "none", preview: "" },
  },
};

/** Stub global fetch: GET /settings → VIEW; PUT /settings → echoes a refreshed view
 *  (with the override applied) so the screen can re-seed its diff baseline. */
function stubFetch(view: SettingsData = VIEW) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.startsWith("/settings")) {
      if (init?.method === "PUT") {
        return Promise.resolve(jsonResponse(view));
      }
      return Promise.resolve(jsonResponse(view));
    }
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Pull the parsed JSON body out of the (first) PUT /settings call. */
function putBody(fetchMock: ReturnType<typeof stubFetch>) {
  const call = fetchMock.mock.calls.find(
    ([url, init]) => url === "/settings" && (init as RequestInit | undefined)?.method === "PUT",
  );
  expect(call).toBeTruthy();
  return JSON.parse((call![1] as RequestInit).body as string) as {
    components: Record<string, { provider?: string; model?: string; params?: Record<string, unknown> }>;
    keys: Record<string, string>;
  };
}

// --- Tests --------------------------------------------------------------------------

describe("Settings — layout + load", () => {
  it("renders the title and subtitle", async () => {
    stubFetch();
    render(<Settings />);
    expect(screen.getByRole("heading", { level: 1, name: "Настройки" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Модели компонентов" })).toBeInTheDocument(),
    );
  });

  it("fetches GET /settings on mount", async () => {
    const fetchMock = stubFetch();
    render(<Settings />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/settings");
  });

  it("renders a provider dropdown + model field per component, and effort only for chat_agent", async () => {
    stubFetch();
    render(<Settings />);

    // Provider dropdown + model field for each of the three components.
    for (const label of ["Анализ ответов", "ИИ-выводы", "Чат-агент"]) {
      expect(await screen.findByLabelText(`Провайдер — ${label}`)).toBeInTheDocument();
      expect(screen.getByLabelText(`Модель — ${label}`)).toBeInTheDocument();
    }

    // Models hydrated from the fetched view.
    expect(screen.getByLabelText("Модель — Анализ ответов")).toHaveValue(
      "anthropic/claude-3.5-sonnet",
    );
    // claude-3.5-haiku isn't in the curated list → surfaced via the «Другая модель» input.
    expect(screen.getByLabelText("Модель вручную — ИИ-выводы")).toHaveValue(
      "anthropic/claude-3.5-haiku",
    );

    // Provider dropdown exposes both the foreign + domestic options.
    const analysisProvider = screen.getByLabelText("Провайдер — Анализ ответов");
    expect(analysisProvider).toHaveValue("openrouter");
    expect(within(analysisProvider).getByRole("option", { name: /Зарубежный/ })).toBeInTheDocument();
    expect(within(analysisProvider).getByRole("option", { name: /Отечественный/ })).toBeInTheDocument();

    // Default effort only appears for the chat agent.
    const effort = screen.getByLabelText("Усилие по умолчанию — Чат-агент");
    expect(effort).toHaveValue("medium");
    expect(screen.queryByLabelText("Усилие по умолчанию — Анализ ответов")).not.toBeInTheDocument();
  });

  it("shows each provider key's status with an optional masked override input", async () => {
    stubFetch();
    render(<Settings />);

    const section = await screen.findByRole("region", { name: "Ключи API" });
    // ENV names rendered.
    expect(within(section).getByText("OPENROUTER_API_KEY")).toBeInTheDocument();
    expect(within(section).getByText("GIGACHAT_CREDENTIALS")).toBeInTheDocument();
    expect(within(section).getByText("GIGACHAT_SCOPE")).toBeInTheDocument();

    // Status: source label + masked preview for the set key, "не задан" for the unset.
    expect(within(section).getByText("из .env")).toBeInTheDocument();
    expect(within(section).getByText("••••cdef")).toBeInTheDocument();
    expect(within(section).getAllByText("не задан").length).toBeGreaterThan(0);

    // Optional masked override input per key.
    const override = within(section).getByLabelText("Переопределить OPENROUTER_API_KEY");
    expect(override).toHaveAttribute("type", "password");
    expect(override).toHaveValue("");
  });

  it("shows a Russian error state with retry when the load fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("boom"));
    vi.stubGlobal("fetch", fetchMock);
    render(<Settings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить настройки");
    expect(screen.getByRole("button", { name: "Повторить" })).toBeInTheDocument();
  });
});

describe("Settings — save", () => {
  it("Save issues PUT /settings with only the changed fields", async () => {
    const fetchMock = stubFetch();
    render(<Settings />);
    await screen.findByLabelText("Модель — Анализ ответов");

    // Change one component's model and the chat-agent effort; leave everything else.
    const model = screen.getByLabelText("Модель — Анализ ответов");
    await userEvent.selectOptions(model, "openai/gpt-4o-mini");
    await userEvent.selectOptions(
      screen.getByLabelText("Усилие по умолчанию — Чат-агент"),
      "high",
    );

    await userEvent.click(screen.getByRole("button", { name: /Сохранить/ }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => url === "/settings" && (init as RequestInit).method === "PUT",
        ),
      ).toBe(true),
    );

    const body = putBody(fetchMock);
    // Only the two touched fields are sent — no untouched provider/model leaks in.
    expect(body.components.analysis).toEqual({ model: "openai/gpt-4o-mini" });
    expect(body.components.chat_agent).toEqual({ params: { effort: "high" } });
    expect(body.components.insight).toBeUndefined();
    // No key overrides were entered, so keys is empty (never wipes a saved key).
    expect(body.keys).toEqual({});
  });

  it("includes a non-empty key override in the PUT and confirms success", async () => {
    const fetchMock = stubFetch();
    render(<Settings />);
    const override = await screen.findByLabelText("Переопределить OPENROUTER_API_KEY");

    await userEvent.type(override, "sk-or-secret");
    await userEvent.click(screen.getByRole("button", { name: /Сохранить/ }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Настройки сохранены."),
    );

    const body = putBody(fetchMock);
    expect(body.keys).toEqual({ OPENROUTER_API_KEY: "sk-or-secret" });
    // No model/provider/effort changed, so components is empty.
    expect(body.components).toEqual({});
  });

  it("surfaces a Russian error when the save fails", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.startsWith("/settings") && init?.method === "PUT") {
        return Promise.resolve(jsonResponse({}, false, 500));
      }
      return Promise.resolve(jsonResponse(VIEW));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Settings />);

    const model = await screen.findByLabelText("Модель — Анализ ответов");
    await userEvent.selectOptions(model, "openai/gpt-4o-mini");
    await userEvent.click(screen.getByRole("button", { name: /Сохранить/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось выполнить действие");
  });
});

describe("Settings — «Параметры анализа» (defaults of every new analysis)", () => {
  const VIEW_WITH_DEFAULTS = {
    ...VIEW,
    analysis_defaults: {
      model_group: "russian",
      model: "GigaChat-3-Ultra",
      provider: "gigachat",
      deep: true,
      max_llm_calls: 500,
      aspects: ["why_failed", "diagnosis", "anomalies", "recommendations"],
    },
  } as SettingsData;

  type PutBody = { analysis_defaults: Record<string, unknown> };
  const putAnalysis = (fetchMock: ReturnType<typeof stubFetch>) =>
    (putBody(fetchMock) as unknown as PutBody).analysis_defaults;

  it("hosts the whole block that used to be on «Новый анализ», hydrated from the saved defaults", async () => {
    stubFetch(VIEW_WITH_DEFAULTS);
    render(<Settings />);
    expect(await screen.findByRole("heading", { name: "Параметры анализа" })).toBeInTheDocument();
    expect((screen.getByLabelText("Группа нейросетей") as HTMLSelectElement).value).toBe("russian");
    expect(screen.getByRole("switch", { name: "Глубокий анализ с ИИ" })).toBeChecked();
    expect((screen.getByLabelText("Максимум обращений к ИИ") as HTMLInputElement).value).toBe("500");
    const chips = screen.getByRole("group", { name: "Что анализировать" });
    for (const chip of ["Ошибки", "Вопросы", "Попытки", "Рекомендации"]) {
      expect(within(chips).getByText(chip)).toBeInTheDocument();
    }
    expect(screen.getByText(/Глубокий анализ с ИИ помогает выявить/)).toBeInTheDocument();
  });

  it("falls back to GigaChat Ultra-era defaults (russian, 500) when the server sends none", async () => {
    stubFetch(); // VIEW has no analysis_defaults
    render(<Settings />);
    await screen.findByRole("heading", { name: "Параметры анализа" });
    expect((screen.getByLabelText("Группа нейросетей") as HTMLSelectElement).value).toBe("russian");
    expect((screen.getByLabelText("Максимум обращений к ИИ") as HTMLInputElement).value).toBe("500");
  });

  it("saves only the changed analysis defaults", async () => {
    const fetchMock = stubFetch(VIEW_WITH_DEFAULTS);
    render(<Settings />);
    await screen.findByRole("heading", { name: "Параметры анализа" });

    await userEvent.selectOptions(screen.getByLabelText("Группа нейросетей"), "foreign");
    await userEvent.click(screen.getByRole("button", { name: "Убрать «Попытки»" }));
    const input = screen.getByLabelText("Максимум обращений к ИИ") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "800");
    await userEvent.click(screen.getByRole("button", { name: /Сохранить/ }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Настройки сохранены."));
    expect(putAnalysis(fetchMock)).toEqual({
      model_group: "foreign",
      max_llm_calls: 800,
      aspects: ["why_failed", "diagnosis", "recommendations"],
    });
  });

  it("re-adds a removed aspect via the dropdown and toggles the AI switch", async () => {
    const fetchMock = stubFetch(VIEW_WITH_DEFAULTS);
    render(<Settings />);
    const chips = await screen.findByRole("group", { name: "Что анализировать" });
    await userEvent.click(screen.getByRole("button", { name: "Убрать «Ошибки»" }));
    expect(within(chips).queryByText("Ошибки")).not.toBeInTheDocument();
    await userEvent.click(chips);
    await userEvent.click(screen.getByRole("option", { name: /Ошибки/ }));
    expect(within(chips).getByText("Ошибки")).toBeInTheDocument();

    const toggle = screen.getByRole("switch", { name: "Глубокий анализ с ИИ" });
    await userEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(screen.getByText("Выключен")).toBeInTheDocument();
    expect(screen.getByLabelText("Максимум обращений к ИИ")).toBeDisabled();
    expect(screen.getByText(/ИИ выключен: будет быстрый расчёт/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Сохранить/ }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Настройки сохранены."));
    expect(putAnalysis(fetchMock)).toEqual({ deep: false });
  });

  it("steps the max-calls number and rejects an invalid value, blocking Save", async () => {
    stubFetch(VIEW_WITH_DEFAULTS);
    render(<Settings />);
    const input = (await screen.findByLabelText("Максимум обращений к ИИ")) as HTMLInputElement;
    await userEvent.click(screen.getByRole("button", { name: "Увеличить" }));
    expect(input.value).toBe("501");
    await userEvent.clear(input);
    await userEvent.type(input, "-5");
    expect(screen.getByText(/Введите целое число от 1/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Сохранить/ })).toBeDisabled();
  });
});
