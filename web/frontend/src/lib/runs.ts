// web/frontend/src/lib/runs.ts
// Shared helpers about saved analyses («запуски»): which course a run belongs to, which
// earlier run is comparable, how to print its date and Russian plural forms. Mirrors
// core/history.py (course_key / previous_comparable) so the UI and the agent agree.
import type { RunMeta } from "@/api/client";

/** Placeholder course the backend saved for runs whose course could not be detected. */
export const GENERIC_COURSE = "анализ";

/** Russian plural form: plural(1,"группа","группы","групп") → "группа". */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(Math.trunc(n));
  if (a % 100 >= 11 && a % 100 <= 14) return many;
  if (a % 10 === 1) return one;
  if (a % 10 >= 2 && a % 10 <= 4) return few;
  return many;
}

/** «5 вопросов», «1 вопрос», «3 вопроса». */
export function count(n: number, one: string, few: string, many: string): string {
  return `${n} ${plural(n, one, few, many)}`;
}

/** Real course label of a run («ЭК 069»), or null when it could not be detected. */
export function courseLabel(meta: { course_id?: string | null }): string | null {
  const c = (meta.course_id ?? "").trim();
  return c && c.toLowerCase() !== GENERIC_COURSE ? c : null;
}

/** «2026-10-10 00:44:12» → «10.10.2026 00:44» (the one date format used everywhere). */
export function formatDateTime(raw: string | null | undefined): string {
  const m = (raw ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return raw ?? "—";
  return `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}`;
}

/** «2026-10-10 …» → «10.10.2026». */
export function formatDate(raw: string | null | undefined): string {
  const m = (raw ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (raw ?? "—");
}

/** Normalised file-ish name: drops .xlsx and «(N групп)» / «_группа N» markers. */
function nameKey(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/\.xlsx$/, "")
    .replace(/\s*\(\s*\d+\s*групп[а-я]*\s*\)/g, "")
    .replace(/[_\-\s]*групп[а-я]*\s*[_-]?\s*\d+/g, "")
    .trim();
}

/** Key saying «same course»: the real course id, else (legacy runs) the file name. */
export function courseKey(meta: { course_id?: string | null; name?: string | null }): string {
  const c = courseLabel(meta);
  return c ? `c:${c.toLowerCase()}` : `n:${nameKey(meta.name)}`;
}

/** Newest run OLDER than `runId` of the same course (preferring the same group set);
 *  `runs` is the newest-first index. null when none. */
export function previousComparable(runs: RunMeta[], runId: string): RunMeta | null {
  const idx = runs.findIndex((r) => r.id === runId);
  if (idx < 0) return null;
  const cur = runs[idx];
  const key = courseKey(cur);
  if (key === "n:" || key === "c:") return null;
  const same = runs.slice(idx + 1).filter((r) => courseKey(r) === key);
  if (!same.length) return null;
  const sig = (r: RunMeta) => [...(r.groups ?? [])].sort().join("|");
  return same.find((r) => sig(r) === sig(cur)) ?? same[0];
}

/** One line identifying a run in pickers: «ЭК 069, группы 1–4, 10.10.2026 00:40». */
export function runTitle(meta: { name: string; created_at: string }): string {
  // New runs already carry the date in their default name; legacy / renamed ones get it appended.
  return /\d{2}\.\d{2}\.\d{4}/.test(meta.name) ? meta.name : `${meta.name} · ${formatDateTime(meta.created_at)}`;
}
