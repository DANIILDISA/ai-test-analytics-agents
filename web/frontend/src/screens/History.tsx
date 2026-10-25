// web/frontend/src/screens/History.tsx
// "История" screen — 1:1 to the designer mockup "История анализов".
// LAYOUT/STYLING preserved; this file adds DATA WIRING: it loads the real run-meta index
// from GET /runs and renders it into the existing table, with loading / empty / error
// states. Everything below the fetch is CLIENT-SIDE over the fetched list:
//   - top stat cards (Всего анализов / За месяц / Средний балл / Высокий риск) are computed
//   - filter panel (Курс / Средний балл / Критические вопросы dropdowns + search) narrows it
//   - the Дата column header sorts by created_at; pagination pages the filtered list
//   - row checkboxes drive «Сравнить выбранные (N)»; with exactly 2 selected it navigates
//     to /compare?a=<id>&b=<id> (the a/b query contract the Сравнение screen reads)
//   - «Word» / «PDF» / «Excel» download the report of that run (GET /download/{id}.{docx,pdf,xlsx})
//   - «Обсудить с агентом» creates a thread bound to that run (POST /threads, context.run_id)
//     and opens /chat
// The effort selector is OUR chat feature, not in this mockup; it lives near the chat
// composer, so it is intentionally absent from this read-only history screen.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  FileText,
  CalendarDays,
  TrendingUp,
  AlertTriangle,
  ChevronDown,
  Search,
  Scale,
  RotateCcw,
  ChevronsUpDown,
  ChevronUp,
  Download,
  MessageCircle,
  ChevronsLeft,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  Loader2,
  Inbox,
  Trash2,
  Pencil,
  Check,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  listRuns,
  createThread,
  deleteRuns,
  renameRun,
  downloadReport,
  REPORT_LABEL,
  type ReportKind,
  type RunMeta,
} from "@/api/client";
import { cn } from "@/lib/utils";
import { courseLabel, formatDateTime, plural } from "@/lib/runs";

// --- Row shape (flattened from RunMeta for the table + client-side filters/sort) -----

interface AnalysisRow {
  id: string;
  createdAt: string; // raw "YYYY-MM-DD HH:MM:SS" — used for sorting
  date: string; // DD.MM.YYYY HH:MM for display
  title: string;
  course: string; // real course label, or "—" when it could not be detected
  group: string; // «1–4» / «2» from the run's group labels; "—" when it is not a multi-group run
  users: number | null;
  questions: number | null;
  score: number | null;
  critical: number | null;
  skippedFiles: number;
}

/** Legacy run names say «(3 групп)» — fix the plural form for display. */
function fixGroupWord(title: string): string {
  return title.replace(
    /\((\d+)\s*групп[а-я]*\)/g,
    (_m, n: string) => `(${n} ${plural(Number(n), "группа", "группы", "групп")})`,
  );
}

/** ["Группа 1","Группа 2","Группа 3"] → "1–3"; ["Группа 2"] → "2"; [] → "—". */
function formatGroups(labels: string[] | undefined): string {
  const list = labels ?? [];
  const nums = list
    .map((l) => Number((l.match(/(\d+)\s*$/) ?? [])[1]))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (!nums.length) return list.length ? list.join(", ") : "—";
  if (nums.length > 2 && nums[nums.length - 1] - nums[0] === nums.length - 1) {
    return `${nums[0]}–${nums[nums.length - 1]}`;
  }
  return nums.join(", ");
}

/** A single-file run has no `groups` metadata, but its auto-name says which group it is
 *  («ЭК 069, группа 4, 14.10.2026 21:07» → «4»; «…, группы 1, 2, 14.10…» → «1, 2»). The
 *  date that follows the numbers must not be read as a group. */
function groupsFromName(name: string | null | undefined): string {
  const m = (name ?? "").match(
    /(?:^|[^а-яёa-z])групп[аы]\s+(\d+\b(?!\.\d)(?:\s*[,–-]\s*\d+\b(?!\.\d))*)/i,
  );
  return m ? m[1].replace(/\s*,\s*/g, ", ").replace(/\s*([–-])\s*/g, "$1") : "—";
}

/** Map a GET /runs index entry (core.history._meta_from) onto a table row. */
function rowFromMeta(m: RunMeta): AnalysisRow {
  const s = m.summary ?? ({} as RunMeta["summary"]);
  return {
    id: m.id,
    createdAt: m.created_at ?? "",
    date: formatDateTime(m.created_at ?? ""),
    title: fixGroupWord(m.name || m.course_id || "Без названия"),
    course: courseLabel(m) ?? "—",
    group: (() => {
      const g = formatGroups(m.groups);
      return g === "—" ? groupsFromName(m.name) : g;
    })(),
    users: s.total_users ?? null,
    questions: s.total_questions ?? null,
    score: s.avg_score ?? null,
    critical: s.critical ?? null,
    skippedFiles: m.skipped_files ?? 0,
  };
}

// --- Stat cards (computed from the fetched list) -----------------------------------

interface Stat {
  icon: LucideIcon;
  tone: "blue" | "green" | "red";
  label: string;
  value: string;
}

/** Is `createdAt` within the current calendar month? Drives the «За месяц» card. */
function isThisMonth(createdAt: string): boolean {
  const m = /^(\d{4})-(\d{2})/.exec(createdAt ?? "");
  if (!m) return false;
  const now = new Date();
  return Number(m[1]) === now.getFullYear() && Number(m[2]) === now.getMonth() + 1;
}

function computeStats(rows: AnalysisRow[]): Stat[] {
  const total = rows.length;
  const month = rows.filter((r) => isThisMonth(r.createdAt)).length;
  const scores = rows.map((r) => r.score).filter((v): v is number => v != null);
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  // "Высокий риск" = runs whose critical-question count lands in the red band (> 5).
  const highRisk = rows.filter((r) => r.critical != null && r.critical > 5).length;
  return [
    { icon: FileText, tone: "blue", label: "Всего анализов", value: String(total) },
    { icon: CalendarDays, tone: "blue", label: "За месяц", value: String(month) },
    { icon: TrendingUp, tone: "green", label: "Средний балл", value: avg == null ? "—" : `${avg}%` },
    { icon: AlertTriangle, tone: "red", label: "Более 5 критических", value: String(highRisk) },
  ];
}

// --- Score / critical pill tones (match the mockup colours) -------------------------

type ScoreTone = "green" | "orange" | "red";

function scoreTone(score: number): ScoreTone {
  if (score >= 75) return "green";
  if (score >= 60) return "orange";
  return "red";
}

function criticalTone(count: number): ScoreTone {
  if (count <= 2) return "green";
  if (count <= 5) return "orange";
  return "red";
}

// --- Filter option vocabularies (the score/critical bands match the pill thresholds) ---

const SCORE_FILTERS = [
  { value: "any", label: "Любой" },
  { value: "high", label: "Высокий (75%+)" },
  { value: "mid", label: "Средний (60–74%)" },
  { value: "low", label: "Низкий (<60%)" },
] as const;
type ScoreFilter = (typeof SCORE_FILTERS)[number]["value"];

const CRITICAL_FILTERS = [
  { value: "any", label: "Любое значение" },
  { value: "ok", label: "0–2" },
  { value: "warn", label: "3–5" },
  { value: "high", label: "Более 5" },
] as const;
type CriticalFilter = (typeof CRITICAL_FILTERS)[number]["value"];

const PER_PAGE_OPTIONS = [10, 20, 50] as const;

function matchScore(score: number | null, f: ScoreFilter): boolean {
  if (f === "any" || score == null) return f === "any";
  if (f === "high") return score >= 75;
  if (f === "mid") return score >= 60 && score < 75;
  return score < 60; // low
}

function matchCritical(critical: number | null, f: CriticalFilter): boolean {
  if (f === "any" || critical == null) return f === "any";
  if (f === "ok") return critical <= 2;
  if (f === "warn") return critical >= 3 && critical <= 5;
  return critical > 5; // high
}

type SortKey = "date" | "users" | "questions" | "score" | "critical";

// --- Load state --------------------------------------------------------------------

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; rows: AnalysisRow[] };

// --- Screen -----------------------------------------------------------------------

export function History() {
  const navigate = useNavigate();

  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // Filters / sort / pagination — all client-side over the fetched list.
  const [search, setSearch] = useState("");
  const [courseFilter, setCourseFilter] = useState("all");
  const [scoreFilter, setScoreFilter] = useState<ScoreFilter>("any");
  const [criticalFilter, setCriticalFilter] = useState<CriticalFilter>("any");
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDesc, setSortDesc] = useState(true); // newest-first by date
  const [perPage, setPerPage] = useState<number>(10);
  const [page, setPage] = useState(1);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    (async () => {
      try {
        const runs = await listRuns();
        if (cancelled) return;
        setState({ phase: "ready", rows: runs.map(rowFromMeta) });
      } catch (e) {
        if (cancelled) return;
        setState({
          phase: "error",
          message: e instanceof Error ? e.message : "Не удалось загрузить историю анализов.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const allRows = state.phase === "ready" ? state.rows : [];

  // Distinct courses present in the data → the «Курс» dropdown options.
  const courses = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRows) if (r.course && r.course !== "—") set.add(r.course);
    return Array.from(set).sort((a, b) => a.localeCompare(b, "ru"));
  }, [allRows]);

  // Any run carrying a group → reveal the «Группа» column/filter is implicit; the column
  // always renders but shows "—" when a run has no group.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = allRows.filter((r) => {
      if (courseFilter !== "all" && r.course !== courseFilter) return false;
      if (!matchScore(r.score, scoreFilter)) return false;
      if (!matchCritical(r.critical, criticalFilter)) return false;
      if (q && !(`${r.title} ${r.course}`.toLowerCase().includes(q))) return false;
      return true;
    });
    out.sort((a, b) => {
      let cmp: number;
      if (sortKey === "date") cmp = a.createdAt.localeCompare(b.createdAt);
      else {
        // Missing values always sink to the bottom regardless of direction.
        const av = a[sortKey];
        const bv = b[sortKey];
        if (av == null && bv == null) cmp = 0;
        else if (av == null) return 1;
        else if (bv == null) return -1;
        else cmp = av - bv;
      }
      return sortDesc ? -cmp : cmp;
    });
    return out;
  }, [allRows, search, courseFilter, scoreFilter, criticalFilter, sortDesc, sortKey]);

  // The cards describe what is currently listed (they follow the filters).
  const stats = useMemo(() => computeStats(filtered), [filtered]);

  function sortBy(key: SortKey) {
    if (key === sortKey) setSortDesc((v) => !v);
    else {
      setSortKey(key);
      setSortDesc(true);
    }
  }

  // Pagination over the filtered list. Reset to page 1 whenever the filtered set or the
  // page size changes so we never sit on an out-of-range page.
  const totalFiltered = filtered.length;
  const pageCount = Math.max(1, Math.ceil(totalFiltered / perPage));
  useEffect(() => {
    setPage(1);
  }, [search, courseFilter, scoreFilter, criticalFilter, perPage, totalFiltered]);
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * perPage;
  const pageRows = filtered.slice(start, start + perPage);

  const visibleIds = useMemo(() => filtered.map((r) => r.id), [filtered]);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      visibleIds.every((id) => prev.has(id))
        ? new Set([...prev].filter((id) => !visibleIds.includes(id)))
        : new Set([...prev, ...visibleIds]),
    );
  }

  function clearFilters() {
    setSearch("");
    setCourseFilter("all");
    setScoreFilter("any");
    setCriticalFilter("any");
    setSelected(new Set());
  }

  const compareCount = selected.size;

  // Deletion: ids awaiting confirmation (null = dialog closed).
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteChats, setDeleteChats] = useState(true); // default ON: don't leave orphaned chats
  const [notice, setNotice] = useState<string | null>(null);

  async function confirmDelete() {
    if (!pendingDelete) return;
    const ids = pendingDelete;
    setDeleting(true);
    setDeleteError(null);
    try {
      const names = allRows.filter((r) => ids.includes(r.id)).map((r) => r.title);
      await deleteRuns(ids, deleteChats);
      setNotice(
        ids.length === 1
          ? `Анализ «${names[0] ?? ids[0]}» удалён${deleteChats ? " вместе со связанными обсуждениями" : ""}.`
          : `Удалено анализов: ${ids.length}${deleteChats ? " (вместе со связанными обсуждениями)" : ""}.`,
      );
      const gone = new Set(ids);
      setState((prev) =>
        prev.phase === "ready" ? { phase: "ready", rows: prev.rows.filter((r) => !gone.has(r.id)) } : prev,
      );
      setSelected((prev) => new Set([...prev].filter((id) => !gone.has(id))));
      setPage(1);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Не удалось удалить анализы.");
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  }

  // Inline rename of an analysis (a readable name instead of a file name).
  async function rename(id: string, name: string) {
    const clean = name.trim();
    if (!clean) return;
    try {
      await renameRun(id, clean);
      setState((prev) =>
        prev.phase === "ready"
          ? { phase: "ready", rows: prev.rows.map((r) => (r.id === id ? { ...r, title: clean } : r)) }
          : prev,
      );
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Не удалось переименовать анализ.");
    }
  }

  // «Сравнить выбранные (2)» → /compare?a=<id>&b=<id>. Enabled only with exactly two.
  const compareSelected = useCallback(() => {
    if (selected.size !== 2) return;
    const [a, b] = [...selected];
    navigate(`/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
  }, [selected, navigate]);

  // «Обсудить с агентом» → bind a thread to this run, then open the chat tab.
  const discuss = useCallback(
    async (row: AnalysisRow) => {
      let threadId: string | null = null;
      try {
        const t = await createThread({
          title: `Обсуждение: ${row.title}`,
          category: "Анализ",
          context: { run_id: row.id },
        });
        threadId = t.id;
      } catch {
        /* Best-effort: still open the chat even if thread creation fails. */
      }
      navigate(threadId ? `/chat?thread=${threadId}` : "/chat");
    },
    [navigate],
  );

  const rangeLabel = totalFiltered
    ? `${start + 1}–${Math.min(start + perPage, totalFiltered)} из ${totalFiltered}`
    : "0 из 0";

  return (
    <div className="h-full overflow-y-auto bg-background font-korpus">
      {/* Wider than the other screens: the table carries 11 columns incl. the report downloads. */}
      <div className="mx-auto max-w-[1560px] px-4 py-6 sm:px-8 sm:py-8">
        {/* 1. Header + stat cards */}
        <header className="flex flex-col gap-6">
          <div className="min-w-0">
            <h1 className="text-[28px] font-bold leading-tight tracking-tight text-foreground sm:text-[40px]">
              История анализов
            </h1>
            <p className="mt-2 text-base text-muted-foreground">
              Найдите предыдущие анализы, отфильтруйте результаты и выберите отчёты для сравнения
            </p>
          </div>

          <section
            aria-label="Сводка по истории"
            className="grid w-full grid-cols-2 gap-4 sm:grid-cols-4"
          >
            {stats.map((s) => (
              <StatCard key={s.label} stat={s} />
            ))}
          </section>
        </header>

        {notice && (
          <div
            role="status"
            className="mt-6 flex items-center justify-between gap-3 rounded-korpus border border-korpus-up/30 bg-korpus-up/10 px-4 py-3 text-sm text-foreground"
          >
            <span>{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Закрыть сообщение"
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>
        )}

        {deleteError && (
          <div
            role="alert"
            className="mt-6 rounded-korpus border border-korpus-down/30 bg-korpus-down/10 px-4 py-3 text-sm text-korpus-down"
          >
            {deleteError}
          </div>
        )}

        {pendingDelete && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Подтверждение удаления"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          >
            <div className="w-full max-w-md rounded-korpus border border-border bg-card p-6 shadow-lg">
              <h2 className="text-lg font-semibold text-foreground">
                {pendingDelete.length === 1
                  ? "Удалить анализ?"
                  : `Удалить анализы (${pendingDelete.length})?`}
              </h2>
              <ul className="mt-2 max-h-40 list-disc overflow-y-auto pl-5 text-sm text-foreground">
                {pendingDelete.map((id) => {
                  const r = allRows.find((x) => x.id === id);
                  return <li key={id}>{r ? `${r.title} · ${r.date}` : id}</li>;
                })}
              </ul>
              <p className="mt-3 text-sm text-muted-foreground">
                Результаты и файлы экспорта будут удалены безвозвратно.
              </p>
              <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={deleteChats}
                  onChange={(e) => setDeleteChats(e.target.checked)}
                  className="mt-0.5 h-[18px] w-[18px] accent-korpus-blue"
                />
                <span>Удалить связанные обсуждения (чаты с агентом по этому анализу)</span>
              </label>
              <div className="mt-5 flex justify-end gap-2">
                <Button type="button" variant="outline" disabled={deleting} onClick={() => setPendingDelete(null)}>
                  Отмена
                </Button>
                <Button
                  type="button"
                  disabled={deleting}
                  onClick={confirmDelete}
                  className="bg-korpus-down text-white hover:bg-korpus-down/90"
                >
                  {deleting ? "Удаление…" : "Удалить"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* 2. Filter panel */}
        <section
          aria-label="Фильтры"
          className="mt-8 rounded-korpus border border-border bg-card p-6 shadow-sm"
        >
          <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <SelectField
              label="Курс"
              value={courseFilter}
              onChange={setCourseFilter}
              options={[{ value: "all", label: "Все курсы" }, ...courses.map((c) => ({ value: c, label: c }))]}
            />
            <SelectField
              label="Средний балл"
              value={scoreFilter}
              onChange={(v) => setScoreFilter(v as ScoreFilter)}
              options={SCORE_FILTERS.map((o) => ({ value: o.value, label: o.label }))}
            />
            <SelectField
              label="Критические вопросы"
              value={criticalFilter}
              onChange={(v) => setCriticalFilter(v as CriticalFilter)}
              options={CRITICAL_FILTERS.map((o) => ({ value: o.value, label: o.label }))}
            />
            <SearchBox value={search} onChange={setSearch} />
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-4">
            <Button
              type="button"
              className="h-11 px-5"
              onClick={compareSelected}
              disabled={compareCount !== 2}
              title={
                compareCount === 2
                  ? undefined
                  : "Выберите ровно два анализа для сравнения"
              }
            >
              <Scale className="h-[18px] w-[18px]" strokeWidth={1.75} />
              Сравнить выбранные ({compareCount})
            </Button>
            {compareCount !== 2 && (
              <span className="text-sm text-muted-foreground">Для сравнения отметьте ровно два анализа</span>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingDelete([...selected])}
              disabled={compareCount === 0}
              className="gap-2 text-korpus-down"
            >
              <Trash2 className="h-[18px] w-[18px]" strokeWidth={1.75} />
              Удалить выбранные ({compareCount})
            </Button>
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-2 text-sm font-semibold text-korpus-blue hover:underline"
            >
              <RotateCcw className="h-[18px] w-[18px]" strokeWidth={1.75} />
              Очистить фильтры
            </button>
          </div>
        </section>

        {/* 3. Table */}
        <section
          aria-label="Список анализов"
          className="mt-6 overflow-hidden rounded-korpus border border-border bg-card shadow-sm"
        >
          {/* `relative`: sr-only labels inside must anchor to this scroller, not the page. */}
          <div className="relative overflow-x-auto">
            {/* From `xl` a real table. Below it every row becomes a card (CSS only, one DOM): name on top,
                small muted meta, badges, then the report downloads - nothing hides behind a sideways
                scroll, and the header turns into a "select all + sort" bar. */}
            <table className="w-full border-collapse text-left max-xl:block">
              <thead className="max-xl:block max-xl:border-b max-xl:border-border">
                <tr className="border-b border-border text-xs font-medium text-muted-foreground max-xl:flex max-xl:flex-wrap max-xl:items-center max-xl:gap-x-4 max-xl:gap-y-1 max-xl:border-0 max-xl:px-3 max-xl:py-2.5">
                  <th scope="col" className="w-12 px-4 py-3 max-xl:w-auto max-xl:p-0">
                    <span className="flex items-center gap-2">
                      <Checkbox
                        checked={allSelected}
                        onChange={toggleAll}
                        label="Выбрать все анализы"
                      />
                      <span aria-hidden className="font-medium text-muted-foreground xl:hidden">
                        Выбрать все
                      </span>
                    </span>
                  </th>
                  <th scope="col" className="whitespace-nowrap px-1.5 py-3 font-medium max-xl:p-0">
                    <SortHeader
                      label="Дата"
                      active={sortKey === "date"}
                      desc={sortDesc}
                      ariaLabel={
                        sortKey === "date" && sortDesc
                          ? "Сортировать по дате: сначала старые"
                          : "Сортировать по дате: сначала новые"
                      }
                      onClick={() => sortBy("date")}
                    />
                  </th>
                  <th scope="col" className="px-1.5 py-3 font-medium max-xl:hidden">
                    Название
                  </th>
                  <th scope="col" className="px-1.5 py-3 font-medium max-xl:hidden">
                    Курс
                  </th>
                  <th scope="col" className="px-1.5 py-3 font-medium max-xl:hidden">
                    Группа
                  </th>
                  <th scope="col" className="whitespace-nowrap px-1.5 py-3 font-medium max-xl:p-0">
                    <SortHeader label="Пользователи" active={sortKey === "users"} desc={sortDesc} onClick={() => sortBy("users")} />
                  </th>
                  <th scope="col" className="px-1.5 py-3 font-medium max-xl:p-0">
                    <SortHeader label="Вопросы" active={sortKey === "questions"} desc={sortDesc} onClick={() => sortBy("questions")} />
                  </th>
                  <th scope="col" className="px-1.5 py-3 font-medium max-xl:p-0">
                    <SortHeader label="Средний балл" active={sortKey === "score"} desc={sortDesc} onClick={() => sortBy("score")} />
                  </th>
                  <th scope="col" className="px-1.5 py-3 font-medium max-xl:p-0">
                    <SortHeader label="Критические вопросы" active={sortKey === "critical"} desc={sortDesc} onClick={() => sortBy("critical")} />
                  </th>
                  <th scope="col" className="whitespace-nowrap px-1.5 py-3 font-medium max-xl:hidden">
                    Файлы отчёта
                  </th>
                  <th scope="col" className="px-1.5 py-3 text-center font-medium max-xl:hidden">
                    Обсудить
                  </th>
                </tr>
              </thead>
              <tbody className="max-xl:grid max-xl:grid-cols-1 max-xl:gap-3 max-xl:p-3 md:max-xl:grid-cols-2">
                {state.phase === "loading" && (
                  <tr className="max-xl:col-span-full">
                    <td colSpan={11} className="max-xl:block px-4 py-16 text-center text-muted-foreground">
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2} />
                        Загрузка истории…
                      </span>
                    </td>
                  </tr>
                )}

                {state.phase === "error" && (
                  <tr className="max-xl:col-span-full">
                    <td colSpan={11} className="max-xl:block px-4 py-12">
                      <div
                        role="alert"
                        className="mx-auto flex max-w-xl items-start gap-3 rounded-korpus border border-korpus-down/30 bg-korpus-down/5 p-4 text-left"
                      >
                        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-korpus-down" strokeWidth={2} />
                        <p className="text-sm leading-relaxed text-korpus-down">{state.message}</p>
                      </div>
                    </td>
                  </tr>
                )}

                {state.phase === "ready" && allRows.length === 0 && (
                  <tr className="max-xl:col-span-full">
                    <td colSpan={11} className="max-xl:block px-4 py-16 text-center">
                      <div className="flex flex-col items-center gap-3 text-muted-foreground">
                        <Inbox className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
                        <p className="text-base font-semibold text-foreground">Пока нет анализов</p>
                        <p className="max-w-md text-sm">
                          Запустите первый анализ на вкладке «Новый анализ» — он появится здесь.
                        </p>
                        <Button type="button" className="mt-1 h-10" onClick={() => navigate("/")}>
                          Создать анализ
                        </Button>
                      </div>
                    </td>
                  </tr>
                )}

                {state.phase === "ready" && allRows.length > 0 && pageRows.length === 0 && (
                  <tr className="max-xl:col-span-full">
                    <td colSpan={11} className="max-xl:block px-4 py-16 text-center text-muted-foreground">
                      <p>Ничего не найдено по выбранным фильтрам.</p>
                      <Button type="button" variant="outline" className="mt-3" onClick={clearFilters}>
                        Сбросить фильтры
                      </Button>
                    </td>
                  </tr>
                )}

                {state.phase === "ready" &&
                  pageRows.map((row) => (
                    <Row
                      key={row.id}
                      row={row}
                      selected={selected.has(row.id)}
                      onToggle={() => toggleRow(row.id)}
                      onDiscuss={() => discuss(row)}
                      onDelete={() => setPendingDelete([row.id])}
                      onRename={(name) => rename(row.id, name)}
                    />
                  ))}
              </tbody>
            </table>
          </div>

          {/* 4. Footer / pagination */}
          <div className="flex flex-col items-center gap-4 border-t border-border px-4 py-4 md:flex-row md:justify-between">
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <span className="whitespace-nowrap">Показывать по</span>
              <PerPageSelect value={perPage} onChange={setPerPage} />
            </div>

            <nav aria-label="Пагинация" className={cn("flex items-center gap-1", totalFiltered === 0 && "invisible")}>
              <PagerButton
                label="Первая страница"
                icon={ChevronsLeft}
                disabled={currentPage <= 1}
                onClick={() => setPage(1)}
              />
              <PagerButton
                label="Предыдущая страница"
                icon={ChevronLeft}
                disabled={currentPage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              />
              {pageNumbers(currentPage, pageCount).map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-current={p === currentPage ? "page" : undefined}
                  onClick={() => setPage(p)}
                  className={cn(
                    "flex h-9 min-w-9 items-center justify-center rounded-korpus px-2 text-sm font-medium transition-colors",
                    p === currentPage
                      ? "bg-korpus-blue text-white"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {p}
                </button>
              ))}
              <PagerButton
                label="Следующая страница"
                icon={ChevronRight}
                disabled={currentPage >= pageCount}
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              />
              <PagerButton
                label="Последняя страница"
                icon={ChevronsRight}
                disabled={currentPage >= pageCount}
                onClick={() => setPage(pageCount)}
              />
            </nav>

            <p className="whitespace-nowrap text-sm text-muted-foreground">{rangeLabel}</p>
          </div>
        </section>
      </div>
    </div>
  );
}

// --- Page-number window (compact pager around the current page) ---------------------

function pageNumbers(current: number, count: number): number[] {
  const span = 5;
  if (count <= span) return Array.from({ length: count }, (_, i) => i + 1);
  let start = Math.max(1, current - 2);
  const end = Math.min(count, start + span - 1);
  start = Math.max(1, end - span + 1);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

// --- Stat card --------------------------------------------------------------------

const STAT_BADGE: Record<Stat["tone"], string> = {
  blue: "bg-korpus-blue/10 text-korpus-blue",
  green: "bg-korpus-up/10 text-korpus-up",
  red: "bg-korpus-down/10 text-korpus-down",
};

function StatCard({ stat }: { stat: Stat }) {
  const Icon = stat.icon;
  return (
    <article className="flex items-center gap-3 rounded-korpus border border-border bg-card px-4 py-3 shadow-sm">
      <span
        className={cn(
          "hidden h-11 w-11 shrink-0 items-center justify-center rounded-korpus lg:flex",
          STAT_BADGE[stat.tone],
        )}
      >
        <Icon className="h-5 w-5" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 leading-tight">
        <p className="text-[13px] font-medium text-muted-foreground">{stat.label}</p>
        <p className="mt-0.5 text-2xl font-bold leading-none text-foreground">{stat.value}</p>
      </div>
    </article>
  );
}

// --- Filter select (a real <select> wired to client-side state) ---------------------

interface Option {
  value: string;
  label: string;
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Option[];
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-foreground">{label}</span>
      <div className="relative">
        <select
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-11 w-full appearance-none rounded-korpus border border-border bg-background px-3 pr-9 text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-korpus-blue"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          strokeWidth={2}
        />
      </div>
    </label>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="sr-only">Поиск по названию анализа</span>
      {/* Spacer aligns the search box baseline with the labelled selects on the same row. */}
      <span aria-hidden className="hidden h-[18px] xl:block" />
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          strokeWidth={1.75}
        />
        <input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Поиск по названию анализа"
          className="h-11 w-full rounded-korpus border border-border bg-background pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-korpus-blue"
        />
      </div>
    </label>
  );
}

// --- Checkbox ---------------------------------------------------------------------

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={label}
      className="h-[18px] w-[18px] cursor-pointer rounded border-border text-korpus-blue accent-korpus-blue focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-korpus-blue"
    />
  );
}

// --- Table row --------------------------------------------------------------------

const SCORE_PILL: Record<ScoreTone, string> = {
  green: "bg-korpus-up/10 text-korpus-up",
  orange: "bg-orange-100 text-orange-600",
  red: "bg-korpus-down/10 text-korpus-down",
};

const CRITICAL_DOT: Record<ScoreTone, string> = {
  green: "bg-korpus-up",
  orange: "bg-orange-500",
  red: "bg-korpus-down",
};

const CRITICAL_BADGE: Record<ScoreTone, string> = {
  green: "bg-korpus-up/10 text-korpus-up",
  orange: "bg-orange-100 text-orange-600",
  red: "bg-korpus-down/10 text-korpus-down",
};

function SortHeader({
  label,
  active,
  desc,
  onClick,
  ariaLabel,
}: {
  label: string;
  active: boolean;
  desc: boolean;
  onClick: () => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? `Сортировать: ${label}`}
      className={cn("inline-flex items-center gap-1 font-medium hover:text-foreground", active && "text-foreground")}
    >
      {label}
      {active ? (
        desc ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/70" strokeWidth={2} />
        ) : (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground/70" strokeWidth={2} />
        )
      ) : (
        <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground/70" strokeWidth={2} />
      )}
    </button>
  );
}

function Row({
  row,
  selected,
  onToggle,
  onDiscuss,
  onDelete,
  onRename,
}: {
  row: AnalysisRow;
  selected: boolean;
  onToggle: () => void;
  onDiscuss: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.title);
  // Report download of this row (fetch → blob): the Russian failure text shows under the buttons.
  const [busy, setBusy] = useState<ReportKind | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const download = async (kind: ReportKind) => {
    if (busy) return;
    setBusy(kind);
    setDownloadError(null);
    try {
      await downloadReport(row.id, kind);
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : "Не удалось скачать отчёт.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <tr
      className={cn(
        "border-b border-border/60 text-sm transition-colors last:border-0",
        "max-xl:relative max-xl:flex max-xl:flex-wrap max-xl:items-center max-xl:gap-x-3 max-xl:gap-y-2 max-xl:rounded-korpus max-xl:border max-xl:border-border max-xl:p-3 max-xl:last:border",
        selected ? "bg-korpus-blue/5" : "hover:bg-muted/50",
      )}
    >
      <td className="relative w-12 px-4 py-4 max-xl:static max-xl:order-1 max-xl:w-auto max-xl:p-0">
        {/* Selected rows get a blue rail on the left, as in the mockup. */}
        {selected && (
          <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-korpus-blue" />
        )}
        <Checkbox checked={selected} onChange={onToggle} label={`Выбрать «${row.title}»`} />
      </td>
      <td className="whitespace-nowrap px-1.5 py-4 text-muted-foreground max-xl:order-3 max-xl:p-0 max-xl:text-xs">{row.date}</td>
      <td className="px-1.5 py-4 max-xl:order-2 max-xl:min-w-0 max-xl:flex-1 max-xl:basis-[calc(100%-2.5rem)] max-xl:p-0">
        {editing ? (
          <span className="flex items-center gap-1">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onRename(draft);
                  setEditing(false);
                } else if (e.key === "Escape") setEditing(false);
              }}
              aria-label="Новое название анализа"
              className="h-8 w-full min-w-0 max-w-[16rem] rounded-korpus border border-border bg-background px-2 text-sm"
            />
            <button
              type="button"
              aria-label="Сохранить название"
              onClick={() => {
                onRename(draft);
                setEditing(false);
              }}
              className="text-korpus-up"
            >
              <Check className="h-4 w-4" strokeWidth={2} />
            </button>
            <button
              type="button"
              aria-label="Отменить переименование"
              onClick={() => setEditing(false)}
              className="text-muted-foreground"
            >
              <X className="h-4 w-4" strokeWidth={2} />
            </button>
          </span>
        ) : (
          <span className="flex max-w-full items-center gap-2 xl:max-w-[13rem] 2xl:max-w-[22rem]">
            {/* A very long (or unbreakable) name must not stretch the table past the screen and
                push the download/discuss columns out of sight: it truncates, tooltip has it all. */}
            <Link
              to={`/results?run=${row.id}`}
              title={`${row.title} — открыть результаты этого анализа`}
              className="min-w-0 truncate font-semibold text-korpus-blue hover:underline"
            >
              {row.title}
            </Link>
            {row.skippedFiles > 0 && (
              <span
                title="Часть загруженных файлов не удалось прочитать — подробности в результатах"
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800"
              >
                <AlertTriangle className="h-3 w-3" strokeWidth={2} aria-hidden />
                не все файлы
              </span>
            )}
            <button
              type="button"
              aria-label={`Переименовать «${row.title}»`}
              onClick={() => {
                setDraft(row.title);
                setEditing(true);
              }}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-1.5 py-4 text-muted-foreground max-xl:order-4 max-xl:p-0 max-xl:text-xs">{row.course}</td>
      <td
        data-label="гр."
        className={cn(
          "whitespace-nowrap px-1.5 py-4 text-muted-foreground max-xl:order-5 max-xl:p-0 max-xl:text-xs max-xl:before:mr-1 max-xl:before:content-[attr(data-label)]",
          row.group === "—" && "max-xl:hidden",
        )}
      >
        {row.group}
      </td>
      <td data-label="Пользователи:" className="px-1.5 py-4 text-foreground max-xl:order-6 max-xl:p-0 max-xl:text-xs max-xl:text-muted-foreground max-xl:before:mr-1 max-xl:before:content-[attr(data-label)]">{row.users ?? "—"}</td>
      <td data-label="Вопросы:" className="px-1.5 py-4 text-foreground max-xl:order-7 max-xl:p-0 max-xl:text-xs max-xl:text-muted-foreground max-xl:before:mr-1 max-xl:before:content-[attr(data-label)]">{row.questions ?? "—"}</td>
      <td className="px-1.5 py-4 max-xl:order-8 max-xl:p-0">
        {row.score == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          // Round ONCE: the pill colour and the shown % must agree on the same integer,
          // so a boundary value (e.g. 74.5 → «75%») never gets a tone from the unrounded score.
          <span
            className={cn(
              "inline-flex min-w-[52px] justify-center rounded-full px-2.5 py-1 text-sm font-semibold",
              SCORE_PILL[scoreTone(Math.round(row.score))],
            )}
          >
            {Math.round(row.score)}%
          </span>
        )}
      </td>
      <td className="px-1.5 py-4 max-xl:order-9 max-xl:p-0">
        {row.critical == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-semibold",
              CRITICAL_BADGE[criticalTone(row.critical)],
            )}
          >
            <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", CRITICAL_DOT[criticalTone(row.critical)])} />
            {row.critical}
          </span>
        )}
      </td>
      <td className="px-1.5 py-4 max-xl:order-10 max-xl:basis-full max-xl:border-t max-xl:border-border/60 max-xl:p-0 max-xl:pt-2">
        <div className="flex items-center gap-2.5">
          {/* Reports of this run: Word, PDF and Excel (summary + per-question numbers). */}
          {(["docx", "pdf", "xlsx"] as ReportKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => void download(kind)}
              disabled={busy !== null}
              aria-label={`Скачать ${REPORT_LABEL[kind]} «${row.title}»`}
              className="inline-flex items-center gap-1 text-sm font-semibold text-korpus-blue hover:underline disabled:opacity-50"
            >
              {busy === kind ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden />
              ) : (
                <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
              )}
              {REPORT_LABEL[kind]}
            </button>
          ))}
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Удалить «${row.title}»`}
            className="flex h-7 w-7 items-center justify-center rounded-korpus text-korpus-down transition-colors hover:bg-korpus-down/10"
          >
            <Trash2 className="h-[18px] w-[18px]" strokeWidth={1.75} />
          </button>
        </div>
        {downloadError && (
          <p role="alert" className="mt-1 max-w-[260px] text-xs text-korpus-down">
            {downloadError}
          </p>
        )}
      </td>
      <td className="px-1.5 py-4 max-xl:order-11 max-xl:basis-full max-xl:p-0">
        <div className="flex justify-center max-xl:justify-start">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDiscuss}
            title="Обсудить с агентом"
            className="h-8 gap-1.5 whitespace-nowrap px-2.5 text-korpus-blue"
          >
            <MessageCircle className="h-4 w-4" strokeWidth={1.75} />
            {/* Label from 2xl up; below that the column is icon-only (tooltip + screen readers keep the text). */}
            <span className="sr-only max-xl:not-sr-only 2xl:not-sr-only">Обсудить с агентом</span>
          </Button>
        </div>
      </td>
    </tr>
  );
}

// --- Pager + per-page controls ----------------------------------------------------

function PagerButton({
  label,
  icon: Icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-9 w-9 items-center justify-center rounded-korpus text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      <Icon className="h-4 w-4" strokeWidth={2} />
    </button>
  );
}

function PerPageSelect({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="relative">
      <select
        aria-label="Показывать по"
        value={String(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-9 appearance-none rounded-korpus border border-border bg-background py-0 pl-3 pr-8 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-korpus-blue"
      >
        {PER_PAGE_OPTIONS.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        strokeWidth={2}
      />
    </div>
  );
}
