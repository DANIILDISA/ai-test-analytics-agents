// web/frontend/src/components/settings/AnalysisParamsPanel.tsx
// «Параметры анализа» — the model group, «Глубокий анализ с ИИ», «Что анализировать» and
// «Максимум обращений к ИИ» controls. They live on the Settings screen (⚙) and are saved as the
// defaults of every run started on «Новый анализ» (core.settings → analysis_defaults).
import * as React from "react";
import { useRef, useState, useEffect } from "react";
import { Settings as SettingsIcon, Info, X, Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { ASPECT_OPTIONS, MAX_CALLS_LIMIT, MODEL_GROUPS } from "@/lib/analysisParams";

export interface AnalysisDraft {
  model_group: string;
  deep: boolean;
  aspects: string[]; // insight block keys
  max_llm_calls: number;
}

// --- Параметры анализа -----------------------------------------------------------

interface AnalysisParamsPanelProps {
  value: AnalysisDraft;
  onChange: (patch: Partial<AnalysisDraft>) => void;
  /** Validation message of the typed max-calls value (null = valid); the screen blocks Save on it. */
  maxCallsError: string | null;
  onMaxCallsError: (msg: string | null) => void;
}

export function AnalysisParamsPanel({ value, onChange, maxCallsError, onMaxCallsError }: AnalysisParamsPanelProps) {
  const { model_group: group, deep, aspects, max_llm_calls: maxCalls } = value;
  const toggleAspect = (key: string) =>
    // keep the canonical order so a re-added aspect slots back into place
    onChange({
      aspects: ASPECT_OPTIONS.map((a) => a.key).filter((k) => (k === key ? !aspects.includes(k) : aspects.includes(k))),
    });
  return (
    <section
      aria-label="Параметры анализа"
      className="rounded-korpus border border-border bg-card p-6 shadow-sm"
    >
      <div className="flex items-center gap-2.5">
        <SettingsIcon className="h-5 w-5 text-korpus-blue" strokeWidth={1.75} />
        <h2 className="text-lg font-semibold text-foreground">Параметры анализа</h2>
      </div>
      <p className="mt-1.5 text-[13px] text-muted-foreground">
        Эти параметры применяются к каждому новому анализу. Менять их на экране запуска не нужно.
      </p>

      {/* Control grid */}
      <div className="mt-5 grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
        {/* Группа нейросетей */}
        <Field
          label="Группа нейросетей"
          hint="Какой провайдер ИИ обрабатывает анализ: зарубежные модели (OpenRouter) или российские (GigaChat)."
        >
          <div className="relative">
            <select
              value={group}
              onChange={(e) => onChange({ model_group: e.target.value })}
              aria-label="Группа нейросетей"
              className="h-10 w-full appearance-none rounded-korpus border border-border bg-background px-3 pr-9 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-korpus-blue"
            >
              {MODEL_GROUPS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden
              className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
          </div>
        </Field>

        {/* Что анализировать — working multiselect (add + remove) */}
        <Field
          label="Что анализировать"
          hint="Какие аспекты включить в ИИ-выводы: ошибки, сложные вопросы, брошенные попытки, рекомендации. Работает только при включённом глубоком анализе."
        >
          <div className={cn(!deep && "pointer-events-none opacity-50")} aria-disabled={!deep}>
            <AspectMultiSelect selected={aspects} onToggle={toggleAspect} />
          </div>
        </Field>

        {/* Глубокий анализ с ИИ — toggle */}
        <Field
          label="Глубокий анализ с ИИ"
          hint="Включает разбор свободных ответов и ИИ-комментарий. Без него — быстрый код-анализ без обращений к модели."
        >
          <div className="flex h-10 items-center gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={deep}
              aria-label="Глубокий анализ с ИИ"
              onClick={() => onChange({ deep: !deep })}
              className={cn(
                "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-korpus-blue",
                deep ? "bg-korpus-blue" : "bg-border",
              )}
            >
              <span
                className={cn(
                  "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
                  deep ? "translate-x-[22px]" : "translate-x-0.5",
                )}
              />
            </button>
            <span className="text-sm text-foreground">{deep ? "Включен" : "Выключен"}</span>
          </div>
        </Field>

        {/* Максимум обращений к ИИ — free-typed number, clamped on blur (bug #2) */}
        <Field
          label="Максимум обращений к ИИ"
          hint="Верхний предел числа обращений к модели за анализ. Больше — точнее, но дольше. Работает только при включённом глубоком анализе."
        >
          <div className={cn(!deep && "pointer-events-none opacity-50")} aria-disabled={!deep}>
            <MaxCallsInput
              value={maxCalls}
              onChange={(n) => onChange({ max_llm_calls: n })}
              onError={onMaxCallsError}
              disabled={!deep}
            />
          </div>
          {deep && maxCallsError && (
            <p role="alert" className="text-xs text-korpus-down">
              {maxCallsError}
            </p>
          )}
          {deep && !maxCallsError && (
            <p className="text-xs text-muted-foreground">
              Это предел, а не план: на практике обращений обычно заметно меньше; анализ нескольких групп
              занимает порядка 30–60 секунд.
            </p>
          )}
        </Field>
      </div>

      {/* Info note */}
      <div className="mt-6 flex items-start gap-3 rounded-korpus bg-muted p-4">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-korpus-blue" strokeWidth={2} />
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {deep
            ? "Глубокий анализ с ИИ помогает выявить повторяющиеся ошибки, аномалии и рекомендации по улучшению курса. Большее число обращений к ИИ повышает точность, но увеличивает время обработки."
            : "ИИ выключен: будет быстрый расчёт по правилам (несколько секунд) — цифры, критические вопросы, частые ошибки, анализ попыток. ИИ-выводы и разбор свободных ответов появятся, если включить глубокий анализ."}
        </p>
      </div>
    </section>
  );
}

// --- Small helpers ---------------------------------------------------------------

/** Label + info (i) glyph above a control. The ⓘ shows a tooltip on hover/focus (#4). */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {hint && (
          <span className="group/hint relative inline-flex">
            <Info
              tabIndex={0}
              aria-label={hint}
              className="h-3.5 w-3.5 cursor-help text-muted-foreground outline-none"
              strokeWidth={1.75}
            />
            <span
              role="tooltip"
              className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 w-60 -translate-x-1/2 rounded-korpus bg-foreground px-3 py-2 text-xs font-normal leading-snug text-background opacity-0 shadow-lg transition-opacity duration-150 group-hover/hint:opacity-100 group-focus-within/hint:opacity-100"
            >
              {hint}
            </span>
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/** «Что анализировать» — a real multiselect: chips remove on ×, the dropdown adds back
 *  any aspect (fixes #3 — removed chips were unrecoverable, the chevron was dead). */
function AspectMultiSelect({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <div
        role="group"
        aria-label="Что анализировать"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-10 cursor-pointer flex-wrap items-center gap-2 rounded-korpus border border-border bg-background px-2.5 py-1.5 pr-9"
      >
        {selected.length === 0 ? (
          <span className="px-1 text-sm text-muted-foreground">Ничего не выбрано</span>
        ) : (
          ASPECT_OPTIONS.filter((o) => selected.includes(o.key)).map(({ key: a, label }) => (
            <span
              key={a}
              className="inline-flex items-center gap-1 rounded-full bg-korpus-blue/10 py-0.5 pl-2.5 pr-1.5 text-[13px] font-medium text-korpus-blue"
            >
              {label}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(a);
                }}
                aria-label={`Убрать «${label}»`}
                className="rounded-full p-0.5 hover:bg-korpus-blue/20"
              >
                <X className="h-3 w-3" strokeWidth={2.5} />
              </button>
            </span>
          ))
        )}
        <ChevronDown
          aria-hidden
          className={cn(
            "absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </div>

      {open && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-korpus border border-border bg-card py-1 shadow-lg"
        >
          {ASPECT_OPTIONS.map(({ key: a, label }) => {
            const on = selected.includes(a);
            return (
              <li key={a}>
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => onToggle(a)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-muted"
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                      on ? "border-korpus-blue bg-korpus-blue text-white" : "border-border",
                    )}
                  >
                    {on && <Check className="h-3 w-3" strokeWidth={3} />}
                  </span>
                  {label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** «Максимум обращений к ИИ» — free-typed while editing, validated live (1…limit) and clamped
 *  only on blur/Enter, so large numbers like 500 can be typed normally (fixes #2). Steppers ±1. */
function MaxCallsInput({
  value,
  onChange,
  onError,
  disabled,
}: {
  value: number;
  onChange: (n: number) => void;
  onError: (msg: string | null) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]); // sync when steppers/reset change value

  const validate = (raw: string): string | null => {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > MAX_CALLS_LIMIT) {
      return `Введите целое число от 1 до ${MAX_CALLS_LIMIT}.`;
    }
    return null;
  };

  const commit = () => {
    const err = validate(text);
    onError(err);
    if (!err) onChange(clampInt(text));
    else {
      // Out-of-range input snaps to the nearest valid value on leaving the field.
      const fixed = Math.min(MAX_CALLS_LIMIT, clampInt(text));
      setText(String(fixed));
      onChange(fixed);
      onError(null);
    }
  };

  return (
    <div className="relative">
      <input
        type="number"
        min={1}
        max={MAX_CALLS_LIMIT}
        inputMode="numeric"
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          onError(validate(e.target.value));
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        aria-label="Максимум обращений к ИИ"
        aria-invalid={validate(text) !== null}
        className="h-10 w-full rounded-korpus border border-border bg-background px-3 pr-9 text-sm text-foreground [appearance:textfield] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-korpus-blue [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 flex-col">
        <button
          type="button"
          aria-label="Увеличить"
          onClick={() => onChange(Math.min(MAX_CALLS_LIMIT, clampInt(text) + 1))}
          className="flex h-4 w-5 items-center justify-center text-muted-foreground hover:text-foreground"
        >
          <ChevronUp className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
        <button
          type="button"
          aria-label="Уменьшить"
          onClick={() => onChange(Math.max(1, clampInt(text) - 1))}
          className="flex h-4 w-5 items-center justify-center text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

function clampInt(raw: string): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}
