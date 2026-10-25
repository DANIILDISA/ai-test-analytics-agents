// web/frontend/src/screens/Settings.tsx
// «Минимальные Настройки» — wires the /settings route to the live backend.
// GET /settings (core.settings.ui_view) returns:
//   { components: { analysis, insight, chat_agent } each {provider, model, params},
//     keys: { <ENV_NAME>: {set, source, preview} } }
// Per component the user picks a provider (Зарубежный = openrouter | Отечественный =
// gigachat) and a model; chat_agent also gets a default effort. Each provider key shows
// its status (set/source/preview) with an OPTIONAL masked override input. Save → PUT
// /settings sending ONLY the changed fields (the backend deep-merges, web/api.py).
//
// Styling: minimal КОРПУС (user explicitly OK'd minimal here) — reusing the card / field
// / dropdown idioms from the other screens (NewAnalysis ParamsPanel), not a redesign.
import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import {
  Settings as SettingsIcon,
  KeyRound,
  ChevronDown,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Save,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getSettings,
  putSettings,
  FALLBACK_ANALYSIS_DEFAULTS,
  type SettingsPatch,
  type SettingsWithDefaults,
} from "@/api/client";
import { AnalysisParamsPanel, type AnalysisDraft } from "@/components/settings/AnalysisParamsPanel";
import type { KeyStatus } from "@/types/chat";
import { EFFORTS } from "@/types/chat";
import { cn } from "@/lib/utils";

// --- Static copy --------------------------------------------------------------------

/** The three configurable LLM components (core.settings.COMPONENTS), in display order. */
const COMPONENTS = [
  { key: "analysis", label: "Анализ ответов" },
  { key: "insight", label: "ИИ-выводы" },
  { key: "chat_agent", label: "Чат-агент" },
] as const;
type ComponentKey = (typeof COMPONENTS)[number]["key"];

/** Provider dropdown: wire value (core.config) ↔ Russian label. */
const PROVIDERS = [
  { value: "openrouter", label: "Зарубежный (OpenRouter)" },
  { value: "gigachat", label: "Отечественный (GigaChat)" },
] as const;

/** Models valid for each provider — so the model can't mismatch the provider (R2-7).
 *  «__custom__» reveals a free-text slug for any other OpenRouter model. */
const CUSTOM = "__custom__";
const MODELS_BY_PROVIDER: Record<string, { value: string; label: string }[]> = {
  openrouter: [
    { value: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash (дёшево)" },
    { value: "openai/gpt-4o-mini", label: "GPT-4o mini" },
    { value: "openai/gpt-4o", label: "GPT-4o" },
    { value: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
    { value: "google/gemini-2.0-flash-001", label: "Gemini 2.0 Flash" },
  ],
  gigachat: [
    { value: "GigaChat-3-Ultra", label: "GigaChat 3 Ultra — рекомендуется" },
    { value: "GigaChat-2-Max", label: "GigaChat 2 Max" },
    { value: "GigaChat-2-Pro", label: "GigaChat 2 Pro" },
    { value: "GigaChat-3-Pro", label: "GigaChat 3 Pro" },
    { value: "GigaChat-3-Lightning", label: "GigaChat 3 Lightning (быстрая)" },
    { value: "GigaChat-2", label: "GigaChat 2 (Lite)" },
  ],
};

/** A sensible default model for a provider (used when the provider changes). */
function defaultModelFor(provider: string): string {
  return MODELS_BY_PROVIDER[provider]?.[0]?.value ?? "";
}

/** Per-provider credential ENV names (core.settings.KEY_ENV_NAMES) grouped for display. */
const KEY_GROUPS: { provider: string; title: string; envNames: string[] }[] = [
  { provider: "openrouter", title: "Зарубежный (OpenRouter)", envNames: ["OPENROUTER_API_KEY"] },
  {
    provider: "gigachat",
    title: "Отечественный (GigaChat)",
    envNames: ["GIGACHAT_CREDENTIALS", "GIGACHAT_SCOPE"],
  },
];

const SOURCE_LABEL: Record<KeyStatus["source"], string> = {
  ui: "сохранён в настройках",
  env: "из .env",
  none: "не задан",
};

// --- Local editable shape -----------------------------------------------------------

interface ComponentDraft {
  provider: string;
  model: string;
  effort?: string; // chat_agent only
}

/** Pull the editable fields out of the ui_view component entry. */
function draftFromSettings(data: SettingsData, key: ComponentKey): ComponentDraft {
  const c = data.components[key] ?? { provider: "", model: "", params: {} };
  return {
    provider: c.provider ?? "",
    model: c.model ?? "",
    effort: key === "chat_agent" ? c.params?.effort ?? "medium" : undefined,
  };
}

type SettingsData = SettingsWithDefaults;

/** The editable analysis defaults out of the ui_view (built-in ones when the server omits them). */
function analysisDraftFrom(data: SettingsData): AnalysisDraft {
  const d = { ...FALLBACK_ANALYSIS_DEFAULTS, ...(data.analysis_defaults ?? {}) };
  return { model_group: d.model_group, deep: d.deep, aspects: [...d.aspects], max_llm_calls: d.max_llm_calls };
}

export function Settings() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Editable drafts per component + the masked key override inputs (empty = unchanged).
  const [drafts, setDrafts] = useState<Record<ComponentKey, ComponentDraft> | null>(null);
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  // «Параметры анализа» — defaults of every new analysis; maxCallsError blocks Save while the typed value is invalid.
  const [analysis, setAnalysis] = useState<AnalysisDraft | null>(null);
  const [maxCallsError, setMaxCallsError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const fresh = await getSettings();
      setData(fresh);
      setDrafts({
        analysis: draftFromSettings(fresh, "analysis"),
        insight: draftFromSettings(fresh, "insight"),
        chat_agent: draftFromSettings(fresh, "chat_agent"),
      });
      setKeyInputs({});
      setAnalysis(analysisDraftFrom(fresh));
      setMaxCallsError(null);
    } catch (e) {
      void e;
      setLoadError("Не удалось загрузить настройки. Проверьте, что программа запущена, и нажмите «Повторить».");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Initial drafts (from the loaded snapshot) used to diff against current edits. */
  const initialDrafts = useMemo<Record<ComponentKey, ComponentDraft> | null>(() => {
    if (!data) return null;
    return {
      analysis: draftFromSettings(data, "analysis"),
      insight: draftFromSettings(data, "insight"),
      chat_agent: draftFromSettings(data, "chat_agent"),
    };
  }, [data]);

  const initialAnalysis = useMemo<AnalysisDraft | null>(() => (data ? analysisDraftFrom(data) : null), [data]);

  const updateAnalysis = (patch: Partial<AnalysisDraft>) => {
    setSaved(false);
    setAnalysis((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const updateDraft = (key: ComponentKey, patch: Partial<ComponentDraft>) => {
    setSaved(false);
    setDrafts((prev) => (prev ? { ...prev, [key]: { ...prev[key], ...patch } } : prev));
  };

  const updateKeyInput = (envName: string, value: string) => {
    setSaved(false);
    setKeyInputs((prev) => ({ ...prev, [envName]: value }));
  };

  /** Build the partial PUT body: only fields that differ from the loaded snapshot, plus
   *  any non-empty key overrides. Empty key inputs are omitted (never wipe a saved key). */
  const buildPatch = (): SettingsPatch => {
    const patch: SettingsPatch = {};
    if (drafts && initialDrafts) {
      const components: NonNullable<SettingsPatch["components"]> = {};
      for (const { key } of COMPONENTS) {
        const cur = drafts[key];
        const init = initialDrafts[key];
        const compPatch: { provider?: string; model?: string; params?: Record<string, unknown> } = {};
        if (cur.provider !== init.provider) compPatch.provider = cur.provider;
        if (cur.model !== init.model) compPatch.model = cur.model;
        if (key === "chat_agent" && cur.effort !== init.effort && cur.effort) {
          compPatch.params = { effort: cur.effort };
        }
        if (Object.keys(compPatch).length > 0) components[key] = compPatch;
      }
      if (Object.keys(components).length > 0) patch.components = components;
    }
    if (analysis && initialAnalysis) {
      const changed: NonNullable<SettingsPatch["analysis_defaults"]> = {};
      if (analysis.model_group !== initialAnalysis.model_group) changed.model_group = analysis.model_group;
      if (analysis.deep !== initialAnalysis.deep) changed.deep = analysis.deep;
      if (analysis.max_llm_calls !== initialAnalysis.max_llm_calls) changed.max_llm_calls = analysis.max_llm_calls;
      if (analysis.aspects.join("|") !== initialAnalysis.aspects.join("|")) changed.aspects = analysis.aspects;
      if (Object.keys(changed).length > 0) patch.analysis_defaults = changed;
    }
    const keys: Record<string, string> = {};
    for (const [envName, value] of Object.entries(keyInputs)) {
      if (value.trim()) keys[envName] = value;
    }
    if (Object.keys(keys).length > 0) patch.keys = keys;
    return patch;
  };

  const save = async () => {
    if (saving || (analysis?.deep && maxCallsError)) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const fresh = await putSettings(buildPatch());
      // Re-seed from the server's refreshed ui_view so the diff baseline resets and the
      // key status (source → "ui", preview) reflects what was just saved.
      setData(fresh);
      setDrafts({
        analysis: draftFromSettings(fresh, "analysis"),
        insight: draftFromSettings(fresh, "insight"),
        chat_agent: draftFromSettings(fresh, "chat_agent"),
      });
      setKeyInputs({});
      setAnalysis(analysisDraftFrom(fresh));
      setSaved(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Не удалось сохранить настройки.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-background font-korpus">
      <div className="mx-auto max-w-[900px] px-4 py-6 sm:px-8 sm:py-8">
        <header>
          <h1 className="text-[28px] font-bold leading-tight tracking-tight text-foreground sm:text-[40px]">
            Настройки
          </h1>
          <p className="mt-2 text-base text-muted-foreground">
            Параметры анализа, модели компонентов и ключи API
          </p>
        </header>

        {loading && (
          <div className="mt-10 flex items-center gap-3 text-muted-foreground" role="status">
            <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2} />
            <span className="text-sm">Загрузка настроек…</span>
          </div>
        )}

        {loadError && !loading && (
          <div
            role="alert"
            className="mt-10 flex items-start gap-3 rounded-korpus border border-korpus-down/30 bg-korpus-down/5 p-4"
          >
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-korpus-down" strokeWidth={2} />
            <div className="min-w-0">
              <p className="text-sm leading-relaxed text-korpus-down">{loadError}</p>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-1 text-sm font-semibold text-korpus-blue hover:underline"
              >
                Повторить
              </button>
            </div>
          </div>
        )}

        {!loading && !loadError && data && drafts && analysis && (
          <div className="mt-8 flex flex-col gap-6">
            {/* Defaults of every new analysis (were on the «Новый анализ» screen). */}
            <AnalysisParamsPanel
              value={analysis}
              onChange={updateAnalysis}
              maxCallsError={maxCallsError}
              onMaxCallsError={setMaxCallsError}
            />

            {/* Per-component model selection. */}
            <section
              aria-label="Модели компонентов"
              className="rounded-korpus border border-border bg-card p-6 shadow-sm"
            >
              <div className="flex items-center gap-2.5">
                <SettingsIcon className="h-5 w-5 text-korpus-blue" strokeWidth={1.75} />
                <h2 className="text-lg font-semibold text-foreground">Модели компонентов</h2>
              </div>

              <div className="mt-5 flex flex-col gap-6">
                {COMPONENTS.map(({ key, label }) => (
                  <ComponentRow
                    key={key}
                    label={label}
                    draft={drafts[key]}
                    isChat={key === "chat_agent"}
                    onProvider={(v) =>
                      // Reset the model to the new provider's default so the two never
                      // mismatch (e.g. GigaChat + a deepseek slug) — R2-7.
                      updateDraft(key, { provider: v, model: defaultModelFor(v) })
                    }
                    onModel={(v) => updateDraft(key, { model: v })}
                    onEffort={(v) => updateDraft(key, { effort: v })}
                  />
                ))}
              </div>
            </section>

            {/* API keys: status + optional masked override per ENV var. */}
            <section
              aria-label="Ключи API"
              className="rounded-korpus border border-border bg-card p-6 shadow-sm"
            >
              <div className="flex items-center gap-2.5">
                <KeyRound className="h-5 w-5 text-korpus-blue" strokeWidth={1.75} />
                <h2 className="text-lg font-semibold text-foreground">Ключи API</h2>
              </div>
              <p className="mt-1.5 text-[13px] text-muted-foreground">
                Ключи берутся из .env. Поле ниже — необязательное локальное переопределение; оставьте
                пустым, чтобы сохранить текущий ключ.
              </p>

              <div className="mt-5 flex flex-col gap-6">
                {KEY_GROUPS.map((grp) => (
                  <div key={grp.provider}>
                    <h3 className="text-sm font-semibold text-foreground">{grp.title}</h3>
                    <div className="mt-3 flex flex-col gap-4">
                      {grp.envNames.map((envName) => (
                        <KeyRow
                          key={envName}
                          envName={envName}
                          status={data.keys?.[envName]}
                          value={keyInputs[envName] ?? ""}
                          onChange={(v) => updateKeyInput(envName, v)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {saveError && (
              <div
                role="alert"
                className="flex items-start gap-3 rounded-korpus border border-korpus-down/30 bg-korpus-down/5 p-4"
              >
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-korpus-down" strokeWidth={2} />
                <p className="text-sm leading-relaxed text-korpus-down">{saveError}</p>
              </div>
            )}

            {saved && !saveError && (
              <div
                role="status"
                className="flex items-center gap-3 rounded-korpus border border-korpus-up/30 bg-korpus-up/5 p-4"
              >
                <CheckCircle2 className="h-5 w-5 shrink-0 text-korpus-up" strokeWidth={2} />
                <p className="text-sm text-foreground">Настройки сохранены.</p>
              </div>
            )}

            <div className="flex items-center gap-4">
              <Button
                type="button"
                className="h-11 px-6 text-base"
                onClick={() => void save()}
                disabled={saving || Boolean(analysis?.deep && maxCallsError)}
              >
                {saving ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2} />
                    Сохранение…
                  </>
                ) : (
                  <>
                    <Save className="h-5 w-5" strokeWidth={1.75} />
                    Сохранить
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Component row ------------------------------------------------------------------

interface ComponentRowProps {
  label: string;
  draft: ComponentDraft;
  isChat: boolean;
  onProvider: (v: string) => void;
  onModel: (v: string) => void;
  onEffort: (v: string) => void;
}

function ComponentRow({ label, draft, isChat, onProvider, onModel, onEffort }: ComponentRowProps) {
  return (
    <div className="rounded-korpus border border-border bg-background p-4">
      <h3 className="text-sm font-semibold text-foreground">{label}</h3>
      <div
        // Same two-column layout in every row, so the model picker is never squeezed; the chat
        // agent's effort select simply wraps onto its own row below.
        className="mt-3 grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2"
      >
        <Field label="Провайдер">
          <Dropdown
            value={draft.provider}
            ariaLabel={`Провайдер — ${label}`}
            onChange={onProvider}
            options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
            // The stored provider may be a value outside the two known ones; keep it visible.
            includeCurrent
          />
        </Field>

        <Field label="Модель">
          <ModelSelect
            provider={draft.provider}
            value={draft.model}
            label={label}
            onChange={onModel}
          />
        </Field>

        {isChat && (
          <Field label="Усилие по умолчанию">
            <Dropdown
              value={draft.effort ?? "medium"}
              ariaLabel="Усилие по умолчанию — Чат-агент"
              onChange={onEffort}
              options={EFFORTS.map((e) => ({ value: e, label: EFFORT_LABEL[e] }))}
            />
          </Field>
        )}
      </div>
    </div>
  );
}

/** Model picker scoped to the provider — its options are the provider's models, so the
 *  model can't mismatch the provider; «Другая модель…» reveals a free-text slug (R2-7). */
function ModelSelect({
  provider,
  value,
  label,
  onChange,
}: {
  provider: string;
  value: string;
  label: string;
  onChange: (v: string) => void;
}) {
  const models = MODELS_BY_PROVIDER[provider] ?? [];
  const isKnown = models.some((m) => m.value === value);
  const selectValue = isKnown ? value : CUSTOM;
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <select
          value={selectValue}
          onChange={(e) => onChange(e.target.value === CUSTOM ? "" : e.target.value)}
          aria-label={`Модель — ${label}`}
          className="h-10 w-full appearance-none rounded-korpus border border-border bg-background px-3 pr-9 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-korpus-blue"
        >
          {models.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
          <option value={CUSTOM}>Другая модель (вписать вручную)…</option>
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
      </div>
      {!isKnown && (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`Модель вручную — ${label}`}
          placeholder={provider === "gigachat" ? "напр. GigaChat-2-Pro" : "напр. openai/gpt-4o"}
          className="h-10 w-full rounded-korpus border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-korpus-blue"
        />
      )}
    </div>
  );
}

const EFFORT_LABEL: Record<string, string> = {
  low: "Низкое",
  medium: "Среднее",
  high: "Высокое",
};

// --- API key row --------------------------------------------------------------------

interface KeyRowProps {
  envName: string;
  status?: KeyStatus;
  value: string;
  onChange: (v: string) => void;
}

function KeyRow({ envName, status, value, onChange }: KeyRowProps) {
  const source = status?.source ?? "none";
  const isSet = status?.set ?? false;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded bg-muted px-1.5 py-0.5 text-[13px] font-medium text-foreground">
          {envName}
        </code>
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
            isSet ? "bg-korpus-blue/10 text-korpus-blue" : "bg-muted text-muted-foreground",
          )}
        >
          {SOURCE_LABEL[source]}
        </span>
        {isSet && status?.preview && (
          <span className="text-xs text-muted-foreground">{status.preview}</span>
        )}
      </div>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`Переопределить ${envName}`}
        placeholder="Переопределить (необязательно)"
        autoComplete="off"
        className="h-10 w-full rounded-korpus border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-korpus-blue"
      />
    </div>
  );
}

// --- Small primitives ---------------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {children}
    </div>
  );
}

interface DropdownProps {
  value: string;
  ariaLabel: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  /** When the current value is not among `options`, render it as a leading option. */
  includeCurrent?: boolean;
}

function Dropdown({ value, ariaLabel, onChange, options, includeCurrent }: DropdownProps) {
  const known = options.some((o) => o.value === value);
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className="h-10 w-full appearance-none rounded-korpus border border-border bg-background px-3 pr-9 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-korpus-blue"
      >
        {includeCurrent && !known && value !== "" && (
          <option value={value}>{value}</option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}
