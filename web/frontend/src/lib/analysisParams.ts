// web/frontend/src/lib/analysisParams.ts
// Shared knowledge about the "Параметры анализа" defaults (edited in Настройки, used by every run
// started on «Новый анализ»): the aspect → insight-block map, the model label and the one-line
// summary shown under the run button.
import type { AnalysisDefaults } from "@/api/client";
import { plural } from "@/lib/runs";

/** «Что анализировать» aspects = insight blocks (agents/insight_agent/options.BLOCK_KEYS). */
export const ASPECT_OPTIONS = [
  { key: "why_failed", label: "Ошибки", modes: ["answer"] },
  { key: "diagnosis", label: "Вопросы", modes: ["answer"] },
  { key: "anomalies", label: "Попытки", modes: ["time"] },
  { key: "recommendations", label: "Рекомендации", modes: ["answer"] },
] as const;

export const ASPECT_KEYS: string[] = ASPECT_OPTIONS.map((a) => a.key);

export const MODEL_GROUPS = [
  { value: "foreign", label: "Зарубежные модели (OpenRouter)" },
  { value: "russian", label: "Российские модели (GigaChat)" },
] as const;

export const MAX_CALLS_LIMIT = 5000;

/** Runner `mode` ("all" | "answer" | "time") needed by the chosen insight blocks. */
export function modeFromBlocks(blocks: string[]): string {
  const modes = new Set<string>(
    ASPECT_OPTIONS.filter((a) => blocks.includes(a.key)).flatMap((a) => [...a.modes]),
  );
  if (modes.has("answer") && modes.has("time")) return "all";
  if (modes.has("time")) return "time";
  return "answer";
}

/** «GigaChat-3-Ultra» → «GigaChat Ultra»; unknown ids are shown as they are. */
export function modelLabel(model?: string, group?: string): string {
  const m = (model ?? "").trim();
  const giga = m.match(/^GigaChat(?:-\d+)?(?:-([A-Za-z]+))?$/);
  if (giga) return `GigaChat ${giga[1] ?? "Lite"}`;
  if (m) return m.includes("/") ? m.split("/").pop()! : m;
  return group === "foreign" ? "OpenRouter" : "GigaChat";
}

/** «GigaChat Ultra · до 500 обращений к ИИ» (or the AI-off wording). */
export function analysisSummary(d: AnalysisDefaults): string {
  if (!d.deep) return "ИИ выключен · быстрый расчёт по правилам";
  const noun = plural(d.max_llm_calls, "обращения", "обращений", "обращений");
  return `${modelLabel(d.model, d.model_group)} · до ${d.max_llm_calls} ${noun} к ИИ`;
}
