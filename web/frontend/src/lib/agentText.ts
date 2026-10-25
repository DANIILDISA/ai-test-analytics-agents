// web/frontend/src/lib/agentText.ts
// The agent's prose sometimes leaks internals: tool names (query_question_errors), run ids
// (20261010-004436-6b83cb) and the word "effort". Shown to a methodologist they look like a
// breakage, so every agent text block goes through humanizeAgentText before it is rendered.

const TOOL_PHRASES: Record<string, string> = {
  query_question_errors: "разбор ошибок по вопросу",
  query_group_stats: "статистика по группе",
  query_by_test: "разбивка по тестам",
  query_students: "список слушателей",
  query_stats: "статистика анализа",
  query_trends: "динамика по анализам",
  list_groups: "список групп",
  list_tests: "список тестов",
  list_runs: "список анализов",
  load_run: "загрузка анализа",
  compare_runs: "сравнение анализов",
  run_analysis: "запуск анализа",
  generate_report: "формирование отчёта",
};

/** Replace tool names, run ids and "effort" with plain Russian. */
export function humanizeAgentText(text: string): string {
  let out = typeof text === "string" ? text : String(text ?? "");
  for (const [name, phrase] of Object.entries(TOOL_PHRASES)) {
    out = out.replace(new RegExp(`\\b${name}\\b(?:\\([^)]*\\))?`, "g"), phrase);
  }
  // Any remaining snake_case tool-like identifier.
  out = out.replace(/\b(?:query|load|list|compare|run|generate)_[a-z_]+\b(?:\([^)]*\))?/g, "служебный расчёт");
  // «Прогон 20261010-004436-6b83cb» / «run_id=…» → «выбранный анализ».
  out = out.replace(/(?:прогон[а-я]*|run_id\s*=?)\s*:?\s*\d{8}-\d{6}-[0-9a-f]{6}/gi, "выбранный анализ");
  out = out.replace(/\b\d{8}-\d{6}-[0-9a-f]{6}\b/g, "выбранный анализ");
  out = out.replace(/повысьте\s+effort/gi, "увеличьте «Глубину» под полем ввода");
  out = out.replace(/\beffort\b/gi, "глубина");
  return out;
}
