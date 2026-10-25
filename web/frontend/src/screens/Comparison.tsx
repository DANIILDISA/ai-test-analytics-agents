// web/frontend/src/screens/Comparison.tsx
// "Сравнение" screen — 1:1 to the designer mockup "Сравнение анализов".
// LAYOUT/STYLING preserved; this file adds DATA WIRING. Run selection:
//   - ?a=<id>&b=<id> in the URL (set by «История» → «Сравнить выбранные»), else two
//     pickers populated from GET /runs let the user choose A and B.
//   - With both ids known we POST /compare {run_id_a, run_id_b} → the token-free diff
//     (agents.insight_agent.compute_diff) and render it into the existing layout.
// Sections (top → bottom), all populated from the diff + the /runs index meta:
//   1. Header (title + subtitle)
//   2. Top row (3 cols): Анализ 1 card | Ключевые различия card | Анализ 2 card
//   3. Middle row (3 cols): Сводные показатели table | Сравнение по ключевым
//      направлениям (Recharts horizontal bars) | ИИ-комментарий к сравнению card
//   4. Bottom row (2 cols): Детальное сравнение метрик table | Что сделать методисту дальше
//   5. Action buttons: Сохранить сравнение / Экспорт отчёта / Обсудить сравнение в чате
// «Обсудить сравнение в чате» binds a thread to the two runs (context.compare = [a, b])
// and opens /chat. The effort selector is OUR chat feature, not part of this read-only
// comparison view, so (like the Results screen) it is intentionally absent here.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Users,
  TrendingUp,
  AlertTriangle,
  Info,
  Gauge,
  Target,
  XCircle,
  Lightbulb,
  ClipboardCheck,
  Sparkles,
  MessageCircle,
  ArrowUpRight,
  ArrowDownRight,
  ChevronRight,
  ChevronDown,
  Scale,
  Loader2,
  Inbox,
  type LucideIcon,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  LabelList,
} from "recharts";
import { Button } from "@/components/ui/button";
import { listRuns, compareRuns, createThread, type RunMeta } from "@/api/client";
import { cn } from "@/lib/utils";
import {
  courseKey,
  courseLabel,
  formatDateTime,
  plural,
  previousComparable,
  runTitle,
} from "@/lib/runs";

// --- Palette helpers --------------------------------------------------------------
// Group 1 reads brand-blue, Group 2 reads brand-green — same as the mockup legend.
const GROUP1_BLUE = "hsl(222 80% 48%)";
const GROUP2_GREEN = "hsl(130 61% 36%)";

// --- Backend diff shape (agents.insight_agent.compute_diff → POST /compare) ----------
// Mirror of the fields this screen reads. `avg_score` is a 0..100 percent; question
// `*_rate` values are 0..1 correct rates; `summary_delta.avg_score` is rounded points.

interface DiffSummary {
  total_users?: number | null;
  total_questions?: number | null;
  avg_score?: number | null;
  real_attempts?: number | null;
  abandoned?: number | null;
}

interface DiffQuestion {
  question_text?: string | null;
  a_rate?: number | null;
  b_rate?: number | null;
  delta?: number | null;
}

interface CompareDiff {
  course_a?: string | null;
  course_b?: string | null;
  summary_a?: DiffSummary;
  summary_b?: DiffSummary;
  summary_delta?: {
    avg_score?: number | null;
    total_users?: number | null;
    critical?: number | null;
  };
  common_count?: number;
  stable_count?: number;
  improved?: DiffQuestion[];
  worsened?: DiffQuestion[];
  new?: { question_text?: string | null; b_rate?: number | null }[];
  dropped?: { question_text?: string | null; a_rate?: number | null }[];
  /** Server-side: false when the two runs belong to different courses. */
  same_course?: boolean | null;
  /** Server-side: false when the runs share no question at all. */
  comparable?: boolean;
}

// --- Derived view models ----------------------------------------------------------

interface GroupMeta {
  name: string;
  course: string;
  group: string;
  date: string;
  tone: "blue" | "green";
}

type DeltaTone = "up" | "down" | "neutral";

interface KeyDifference {
  icon: LucideIcon;
  tone: "blue" | "orange";
  text: string;
}

interface SummaryRow {
  icon: LucideIcon;
  metric: string;
  group1: string;
  group2: string;
  change: string;
  changeTone: DeltaTone;
}

interface DirectionBar {
  label: string;
  group1: number;
  group2: number;
  /** When true, axis values are absolute counts, not percents (критические вопросы). */
  isCount?: boolean;
}

interface AiComment {
  icon: LucideIcon;
  tone: "blue" | "orange" | "green";
  title: string;
  body: string;
}

interface DetailRow {
  metric: string;
  group1: string;
  group2: string;
  change: string;
  changeTone: DeltaTone;
  comment: string;
}

interface ComparisonView {
  /** Why the numbers must not be read as dynamics (different courses / no common questions). */
  caution: string | null;
  /** True when improvement / worsening can be judged (same course and common questions). */
  evaluative: boolean;
  group1: GroupMeta;
  group2: GroupMeta;
  keyDifferences: KeyDifference[];
  summaryRows: SummaryRow[];
  directions: DirectionBar[];
  aiComments: AiComment[];
  detailRows: DetailRow[];
  nextSteps: string[];
}

/** Column / card names: the comparison always reads «Раньше → Позже». */
const EARLIER = "Раньше";
const LATER = "Позже";

// --- Small formatting helpers -----------------------------------------------------

function n(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** A coloured «изменение» string ("+5", "−7", "+9 п.п.") with green/red tone. `goodWhenUp`
 *  decides whether an increase reads green (good) or red (bad); 0 is neutral. */
function delta(value: number, suffix: string, goodWhenUp: boolean): { text: string; tone: DeltaTone } {
  const d = Math.round(value * 10) / 10;
  if (d === 0) return { text: `0${suffix}`, tone: "neutral" };
  const sign = d > 0 ? "+" : "−";
  const up = d > 0;
  const good = goodWhenUp ? up : !up;
  return { text: `${sign}${Math.abs(d)}${suffix}`, tone: good ? "up" : "down" };
}

/** Percent label from a 0..100 avg score (rounded), "—" when absent. */
function pct(v: number | null | undefined): string {
  return typeof v === "number" ? `${Math.round(v)}%` : "—";
}

/** Count label, "—" when absent. */
function count(v: number | null | undefined): string {
  return typeof v === "number" ? String(v) : "—";
}

// --- Build the whole view from the diff + the two run-meta index entries -------------

function plainCount(k: number, one: string, few: string, many: string): string {
  return `${k} ${plural(k, one, few, many)}`;
}

function buildView(diff: CompareDiff, metaA: RunMeta | undefined, metaB: RunMeta | undefined): ComparisonView {
  const common = diff.common_count ?? 0;
  const sameCourse =
    diff.same_course ?? (metaA && metaB ? courseKey(metaA) === courseKey(metaB) : true);
  const evaluative = sameCourse && (diff.comparable ?? common > 0) && common > 0;
  const labelA = (metaA && courseLabel(metaA)) ?? diff.course_a ?? "курс не определён";
  const labelB = (metaB && courseLabel(metaB)) ?? diff.course_b ?? "курс не определён";
  let caution: string | null = null;
  if (!sameCourse) {
    caution =
      `Это разные курсы (${labelA} и ${labelB}): сравнение по вопросам невозможно. ` +
      "Цифры ниже показаны для справки — делать вывод «стало лучше / хуже» нельзя.";
  } else if (common === 0) {
    caution =
      "В этих анализах нет общих вопросов, поэтому динамику по вопросам оценить нельзя. " +
      "Цифры ниже показаны для справки.";
  }
  const sa = diff.summary_a ?? {};
  const sb = diff.summary_b ?? {};
  const sd = diff.summary_delta ?? {};

  const critA = metaA?.summary?.critical ?? null;
  const critB = metaB?.summary?.critical ?? null;
  const usersA = sa.total_users ?? metaA?.summary?.total_users ?? null;
  const usersB = sb.total_users ?? metaB?.summary?.total_users ?? null;
  const avgA = typeof sa.avg_score === "number" ? sa.avg_score : metaA?.summary?.avg_score ?? null;
  const avgB = typeof sb.avg_score === "number" ? sb.avg_score : metaB?.summary?.avg_score ?? null;

  const group1: GroupMeta = {
    name: EARLIER,
    course: labelA,
    group: metaA?.name ?? metaA?.id ?? "—",
    date: metaA ? formatDateTime(metaA.created_at) : "—",
    tone: "blue",
  };
  const group2: GroupMeta = {
    name: LATER,
    course: labelB,
    group: metaB?.name ?? metaB?.id ?? "—",
    date: metaB ? formatDateTime(metaB.created_at) : "—",
    tone: "green",
  };

  // --- Key differences: highlight the avg-score gap, the critical-question gap, and
  //     a count of how many common questions moved (improved/worsened).
  const improved = diff.improved ?? [];
  const worsened = diff.worsened ?? [];
  const avgDelta = typeof sd.avg_score === "number" ? sd.avg_score : n(avgB) - n(avgA);
  const critDelta = typeof sd.critical === "number" ? sd.critical : n(critB) - n(critA);

  const keyDifferences: KeyDifference[] = [];
  if (!evaluative) {
    keyDifferences.push({
      icon: Info,
      tone: "orange",
      text: `Общих вопросов: ${common}. Выводы «улучшилось / ухудшилось» здесь не делаются.`,
    });
  } else {
    if (avgDelta !== 0) {
      const better = avgDelta > 0 ? LATER : EARLIER;
      keyDifferences.push({
        icon: TrendingUp,
        tone: "blue",
        text: `${better} анализ лучше по среднему баллу на ${Math.abs(Math.round(avgDelta * 10) / 10)} п.п.`,
      });
    } else {
      keyDifferences.push({ icon: TrendingUp, tone: "blue", text: "Средний балл анализов совпадает" });
    }
    if (critDelta !== 0) {
      const more = critDelta > 0 ? "позднем" : "раннем";
      keyDifferences.push({
        icon: AlertTriangle,
        tone: "orange",
        text: `В ${more} анализе критических вопросов больше на ${Math.abs(critDelta)}`,
      });
    } else {
      keyDifferences.push({ icon: AlertTriangle, tone: "orange", text: "Число критических вопросов совпадает" });
    }
    keyDifferences.push({
      icon: Info,
      tone: "blue",
      text: `Общих вопросов: ${common}; улучшилось ${improved.length}, ухудшилось ${worsened.length}.`,
    });
  }

  // --- Сводные показатели table.
  const usersChange = delta(n(usersB) - n(usersA), "", true);
  const avgChange = delta(avgDelta, " п.п.", true);
  const realA = sa.real_attempts ?? null;
  const realB = sb.real_attempts ?? null;
  const realChange = delta(n(realB) - n(realA), "", true);
  const abandA = sa.abandoned ?? null;
  const abandB = sb.abandoned ?? null;
  const abandChange = delta(n(abandB) - n(abandA), "", false); // fewer abandoned is better
  const critChange = delta(critDelta, "", false); // fewer critical is better

  // When the runs are not comparable the change is shown as a plain number, never as good / bad.
  const neutralize = (c: { text: string; tone: DeltaTone }) =>
    evaluative ? c : { text: c.text, tone: "neutral" as DeltaTone };
  const summaryRows: SummaryRow[] = [
    { icon: Users, metric: "Пользователи", group1: count(usersA), group2: count(usersB), ...withChange(neutralize(usersChange)) },
    { icon: Gauge, metric: "Средний балл", group1: pct(avgA), group2: pct(avgB), ...withChange(neutralize(avgChange)) },
    { icon: Target, metric: "Реальные попытки", group1: count(realA), group2: count(realB), ...withChange(neutralize(realChange)) },
    { icon: XCircle, metric: "Брошенные попытки", group1: count(abandA), group2: count(abandB), ...withChange(neutralize(abandChange)) },
    { icon: AlertTriangle, metric: "Критические вопросы", group1: count(critA), group2: count(critB), ...withChange(neutralize(critChange)) },
    { icon: Info, metric: "Общих вопросов", group1: String(common), group2: String(common), change: "—", changeTone: "neutral" },
  ];

  // --- Direction bars: avg score, improved/worsened counts among common questions,
  //     and the critical-question counts.
  const directions: DirectionBar[] = [
    { label: "Средний балл", group1: Math.round(n(avgA)), group2: Math.round(n(avgB)) },
    ...(evaluative
      ? [{ label: "Улучшилось / ухудшилось вопросов", group1: improved.length, group2: worsened.length, isCount: true }]
      : []),
    { label: "Количество критических вопросов", group1: n(critA), group2: n(critB), isCount: true },
  ];

  // --- Автоматические выводы: computed from the numbers by code (no AI is involved).
  const aiComments: AiComment[] = evaluative
    ? [
        {
          icon: Info,
          tone: "blue",
          title: "Ключевое различие",
          body:
            avgDelta === 0
              ? "Средний балл анализов совпадает; различия проявляются на уровне отдельных вопросов."
              : `${avgDelta > 0 ? "Более поздний" : "Более ранний"} анализ показывает более высокий средний балл на ${Math.abs(Math.round(avgDelta * 10) / 10)} п.п.`,
        },
        {
          icon: Lightbulb,
          tone: improved.length >= worsened.length ? "green" : "orange",
          title: improved.length >= worsened.length ? "Положительная динамика" : "Зона риска",
          body: `Из ${plainCount(common, "общего вопроса", "общих вопросов", "общих вопросов")} улучшилось ${improved.length}, ухудшилось ${worsened.length}, без изменений ${diff.stable_count ?? 0}.`,
        },
        {
          icon: AlertTriangle,
          tone: "orange",
          title: "Риск интерпретации",
          body:
            n(usersA) < 30 || n(usersB) < 30
              ? "В одном из анализов мало пользователей — различия могут быть связаны с размером выборки."
              : "Выборки сопоставимы по размеру; различия можно интерпретировать с осторожностью.",
        },
        {
          icon: ClipboardCheck,
          tone: "green",
          title: "Вывод",
          body:
            critDelta === 0
              ? "Уровень риска по критическим вопросам не изменился между анализами."
              : `${critDelta > 0 ? "В позднем" : "В раннем"} анализе критических вопросов больше на ${Math.abs(critDelta)} — стоит пересмотреть их формулировки.`,
        },
      ]
    : [
        {
          icon: AlertTriangle,
          tone: "orange",
          title: "Сравнение невозможно",
          body: caution ?? "Нет общих вопросов для сравнения.",
        },
      ];

  // --- Детальное сравнение метрик: the top improved + worsened common questions.
  const detailRows: DetailRow[] = [];
  for (const it of evaluative ? worsened.slice(0, 5) : []) {
    const d = Math.round(n(it.delta) * 100);
    detailRows.push({
      metric: shorten(it.question_text),
      group1: `${Math.round(n(it.a_rate) * 100)}%`,
      group2: `${Math.round(n(it.b_rate) * 100)}%`,
      change: `${d > 0 ? "+" : "−"}${Math.abs(d)} п.п.`,
      changeTone: "down",
      comment: "Доля верных ответов снизилась в позднем анализе.",
    });
  }
  for (const it of evaluative ? improved.slice(0, 5) : []) {
    const d = Math.round(n(it.delta) * 100);
    detailRows.push({
      metric: shorten(it.question_text),
      group1: `${Math.round(n(it.a_rate) * 100)}%`,
      group2: `${Math.round(n(it.b_rate) * 100)}%`,
      change: `${d > 0 ? "+" : "−"}${Math.abs(d)} п.п.`,
      changeTone: "up",
      comment: "Доля верных ответов выросла в позднем анализе.",
    });
  }
  if (detailRows.length === 0) {
    detailRows.push({
      metric: "Средний балл",
      group1: pct(avgA),
      group2: pct(avgB),
      ...withChange(neutralize(avgChange)),
      comment: evaluative
        ? "Заметных изменений по отдельным вопросам не выявлено."
        : "Сравнение по вопросам невозможно.",
    });
  }

  // --- Что сделать методисту дальше: derived next steps.
  const nextSteps: string[] = [];
  if (!evaluative) {
    nextSteps.push("Выбрать для сравнения два анализа одного и того же курса (кнопка «Выбрать другие анализы»)");
    nextSteps.push("Если курсы должны совпадать — проверьте, что в файлах одинаковые тексты вопросов");
  } else {
    if (worsened.length > 0) {
      const k = Math.min(worsened.length, 3);
      nextSteps.push(
        `Пересмотреть ${plainCount(k, "вопрос", "вопроса", "вопросов")} с ухудшившейся долей верных ответов`,
      );
    }
    if (critDelta > 0) {
      nextSteps.push(
        `Проверить ${plainCount(Math.abs(critDelta), "новый критический вопрос", "новых критических вопроса", "новых критических вопросов")} в позднем анализе`,
      );
    }
    if (n(usersA) < 30 || n(usersB) < 30) {
      nextSteps.push("Собрать больше ответов — в одном из анализов малая выборка");
    }
    nextSteps.push("Выровнять формулировки заданий в обоих анализах");
    if (improved.length > 0) {
      nextSteps.push(
        `Перенести удачные формулировки из ${plainCount(improved.length, "улучшившегося вопроса", "улучшившихся вопросов", "улучшившихся вопросов")}`,
      );
    }
  }

  return { caution, evaluative, group1, group2, keyDifferences, summaryRows, directions, aiComments, detailRows, nextSteps };
}

function withChange(c: { text: string; tone: DeltaTone }): { change: string; changeTone: DeltaTone } {
  return { change: c.text, changeTone: c.tone };
}

/** Trim a long question text for the table's «Метрика» column. */
function shorten(text: string | null | undefined): string {
  const t = (text ?? "").trim();
  if (!t) return "Вопрос";
  return t.length > 70 ? `${t.slice(0, 67)}…` : t;
}

// --- Load state --------------------------------------------------------------------

type LoadState =
  | { phase: "loading" }
  | { phase: "empty" } // no runs at all → nothing to compare
  | { phase: "pick"; runs: RunMeta[] } // runs exist but A/B not both chosen yet
  | { phase: "error"; message: string }
  | { phase: "ready"; view: ComparisonView; idA: string; idB: string; runs: RunMeta[] };

// --- Screen -----------------------------------------------------------------------

export function Comparison() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const idA = params.get("a");
  const idB = params.get("b");
  // «Выбрать другие анализы» drops ?a/?b and shows the picker again.

  const [state, setState] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });

    (async () => {
      try {
        const runs = await listRuns();
        if (cancelled) return;
        if (!runs.length) {
          setState({ phase: "empty" });
          return;
        }
        if (!idA || !idB) {
          // Not both chosen yet → show pickers populated from the index.
          setState({ phase: "pick", runs });
          return;
        }
        const diff = (await compareRuns(idA, idB)) as CompareDiff;
        if (cancelled) return;
        // The server puts the EARLIER analysis first (meta_a); fall back to the index.
        const dm = diff as CompareDiff & { meta_a?: RunMeta; meta_b?: RunMeta };
        const metaA = dm.meta_a?.id ? dm.meta_a : runs.find((r) => r.id === idA);
        const metaB = dm.meta_b?.id ? dm.meta_b : runs.find((r) => r.id === idB);
        setState({ phase: "ready", view: buildView(diff, metaA, metaB), idA, idB, runs });
      } catch (e) {
        if (cancelled) return;
        setState({
          phase: "error",
          message: e instanceof Error ? e.message : "Не удалось загрузить сравнение анализов.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [idA, idB]);

  // «Обсудить сравнение в чате» → bind a thread to the two runs, then open the chat tab.
  const discuss = useCallback(async () => {
    let threadId: string | null = null;
    if (idA && idB) {
      try {
        const t = await createThread({
          title: "Обсуждение сравнения",
          category: "Сравнение",
          context: { compare: [idA, idB] },
        });
        threadId = t.id;
      } catch {
        /* Best-effort: still open the chat even if thread creation fails. */
      }
    }
    // Pass the new thread so the chat opens it bound to the comparison (R2-6).
    navigate(threadId ? `/chat?thread=${threadId}` : "/chat");
  }, [idA, idB, navigate]);

  // Picker submit → write ?a=&b= into the URL (the effect re-runs and POSTs /compare).
  const startCompare = useCallback(
    (a: string, b: string) => {
      setParams({ a, b });
    },
    [setParams],
  );

  if (state.phase === "loading") {
    return (
      <CenteredNotice>
        <Loader2 className="h-8 w-8 animate-spin text-korpus-blue" strokeWidth={2} />
        <p className="mt-4 text-base text-muted-foreground">Загружаем сравнение анализов…</p>
      </CenteredNotice>
    );
  }

  if (state.phase === "error") {
    return (
      <CenteredNotice>
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-korpus-down/10 text-korpus-down">
          <AlertTriangle className="h-6 w-6" strokeWidth={2} />
        </span>
        <p className="mt-4 text-base font-semibold text-foreground">Не удалось построить сравнение</p>
        <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
        <Button type="button" className="mt-5 h-11" onClick={() => navigate("/history")}>
          Вернуться к истории
        </Button>
      </CenteredNotice>
    );
  }

  if (state.phase === "empty") {
    return (
      <CenteredNotice>
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-korpus-blue/10 text-korpus-blue">
          <Inbox className="h-6 w-6" strokeWidth={1.75} />
        </span>
        <p className="mt-4 text-base font-semibold text-foreground">Пока нечего сравнивать</p>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          Нужно как минимум два сохранённых анализа. Запустите анализы на вкладке «Новый анализ».
        </p>
        <Button type="button" className="mt-5 h-11" onClick={() => navigate("/")}>
          <Sparkles className="h-[18px] w-[18px]" strokeWidth={2} />
          Создать анализ
        </Button>
      </CenteredNotice>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background font-korpus">
      <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-8 sm:py-8">
        {/* 1. Header */}
        <header>
          <h1 className="text-[28px] font-bold leading-tight tracking-tight text-foreground sm:text-[40px]">
            Сравнение анализов
          </h1>
          <p className="mt-2 text-base text-muted-foreground">
            Сопоставьте два анализа (каждый может включать одну или несколько групп) и получите
            ИИ-комментарий
          </p>
        </header>

        {state.phase === "pick" ? (
          <RunPicker runs={state.runs} onCompare={startCompare} />
        ) : (
          <>
            {state.view.caution && (
              <section
                role="alert"
                aria-label="Предупреждение о сравнении"
                className="mt-6 flex items-start gap-4 rounded-korpus border border-amber-300 bg-amber-50 p-5"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700">
                  <AlertTriangle className="h-5 w-5" strokeWidth={2} />
                </span>
                <div className="min-w-0">
                  <p className="text-base font-semibold text-foreground">Эти анализы нельзя сравнивать как динамику</p>
                  <p className="mt-1 text-sm text-muted-foreground">{state.view.caution}</p>
                </div>
              </section>
            )}
            <p className="mt-4 text-sm text-muted-foreground">
              «Раньше» — более ранний анализ, «Позже» — более поздний; изменение считается как «позже минус раньше».{" "}
              <button
                type="button"
                onClick={() => setParams({})}
                className="font-semibold text-korpus-blue hover:underline"
              >
                Выбрать другие анализы
              </button>
            </p>
            {/* 2. Group headers + key differences */}
            <section
              aria-label="Заголовки анализов"
              className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1fr)]"
            >
              <GroupCard group={state.view.group1} />
              <KeyDifferencesCard differences={state.view.keyDifferences} />
              <GroupCard group={state.view.group2} />
            </section>

            {/* 3. Summary table + direction bars + AI comment */}
            <section
              aria-label="Показатели сравнения"
              className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,0.95fr)]"
            >
              <SummaryTable rows={state.view.summaryRows} />
              <DirectionsPanel directions={state.view.directions} />
              <AiCommentCard comments={state.view.aiComments} />
            </section>

            {/* 4. Detailed metrics table + next steps */}
            <section
              aria-label="Детали сравнения"
              className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]"
            >
              <DetailTable rows={state.view.detailRows} />
              <NextStepsCard steps={state.view.nextSteps} />
            </section>

            {/* 5. Action buttons */}
            <ActionBar onDiscuss={discuss} />
          </>
        )}
      </div>
    </div>
  );
}

/** Full-height centred panel for the loading / empty / error states. */
function CenteredNotice({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto bg-background font-korpus">
      <div className="mx-auto flex min-h-[60vh] max-w-[1320px] flex-col items-center justify-center px-4 py-16 text-center sm:px-8">
        {children}
      </div>
    </div>
  );
}

// --- Run picker (shown when ?a/?b are not both present) -----------------------------

function RunPicker({ runs, onCompare }: { runs: RunMeta[]; onCompare: (a: string, b: string) => void }) {
  // Default: the newest analysis as «Позже» and the previous analysis of the SAME course as «Раньше».
  const latest = runs[0];
  const prev = latest ? previousComparable(runs, latest.id) : null;
  const [a, setA] = useState(prev?.id ?? "");
  const [b, setB] = useState(latest?.id ?? "");
  const metaA = runs.find((r) => r.id === a);
  const metaB = runs.find((r) => r.id === b);
  const same = a !== "" && a === b;
  const crossCourse = Boolean(metaA && metaB && courseKey(metaA) !== courseKey(metaB));
  const ready = Boolean(a) && Boolean(b) && !same;

  return (
    <section
      aria-label="Выбор анализов для сравнения"
      className="mt-6 rounded-korpus border border-border bg-card p-6 shadow-sm"
    >
      <h2 className="text-lg font-semibold text-foreground">Выберите два анализа</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Сравнение можно открыть из «Истории» или выбрать анализы здесь. Сравнивайте анализы одного
        курса: по умолчанию подставлены два последних анализа одного курса.
      </p>
      <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
        <RunSelect label="Раньше" value={a} onChange={setA} runs={runs} tone="blue" disabledId={b} placeholder />
        <RunSelect label="Позже" value={b} onChange={setB} runs={runs} tone="green" disabledId={a} />
      </div>
      {!prev && a === "" && (
        <p className="mt-3 text-sm text-muted-foreground">
          У последнего анализа нет предыдущего анализа этого курса — выберите анализ для сравнения вручную.
        </p>
      )}
      {same && <p className="mt-3 text-sm text-korpus-down">Выберите два разных анализа.</p>}
      {crossCourse && (
        <p className="mt-3 text-sm text-amber-700">
          Это анализы разных курсов. Сравнение вопросов невозможно — будут показаны только общие цифры, без
          выводов «лучше / хуже».
        </p>
      )}
      <Button type="button" className="mt-5 h-11 px-5" disabled={!ready} onClick={() => onCompare(a, b)}>
        <Scale className="h-[18px] w-[18px]" strokeWidth={1.75} />
        Сравнить
      </Button>
    </section>
  );
}

function RunSelect({
  label,
  value,
  onChange,
  runs,
  tone,
  disabledId,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  runs: RunMeta[];
  tone: "blue" | "green";
  disabledId?: string;
  placeholder?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
        <span
          aria-hidden
          className={cn("h-2.5 w-2.5 rounded-sm", tone === "blue" ? "bg-korpus-blue" : "bg-korpus-up")}
        />
        {label}
      </span>
      <div className="relative">
        <select
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-11 w-full appearance-none rounded-korpus border border-border bg-background px-3 pr-9 text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-korpus-blue"
        >
          {placeholder && <option value="">— выберите анализ —</option>}
          {runs.map((r) => (
            <option key={r.id} value={r.id} disabled={r.id === disabledId}>
              {`${courseLabel(r) ?? "курс не определён"} · ${runTitle(r)}`}
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

// --- Group header card ------------------------------------------------------------

function GroupCard({ group }: { group: GroupMeta }) {
  const blue = group.tone === "blue";
  return (
    <article className="flex min-w-0 flex-col rounded-korpus border border-border bg-card p-5 shadow-sm">
      <div className="flex items-start gap-4">
        <span
          className={cn(
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-white",
            blue ? "bg-korpus-blue" : "bg-korpus-up",
          )}
        >
          <Users className="h-6 w-6" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <h2 className="text-lg font-bold text-foreground">{group.name}</h2>
          <dl className="mt-1 space-y-0.5 text-[13px] text-muted-foreground">
            <div>
              <span>Курс: </span>
              <span className="text-foreground">{group.course}</span>
            </div>
            <div>
              <span>Название: </span>
              <span className="text-foreground">{group.group}</span>
            </div>
            <div>
              <span>Дата: </span>
              <span className="text-foreground">{group.date}</span>
            </div>
          </dl>
        </div>
      </div>
    </article>
  );
}

// --- Key differences card ---------------------------------------------------------

const DIFF_TONE: Record<KeyDifference["tone"], string> = {
  blue: "bg-korpus-blue/10 text-korpus-blue",
  orange: "bg-orange-100 text-orange-600",
};

function KeyDifferencesCard({ differences }: { differences: KeyDifference[] }) {
  return (
    <section
      aria-label="Ключевые различия"
      className="flex flex-col rounded-korpus border border-border bg-card p-5 shadow-sm"
    >
      <h2 className="text-base font-semibold text-foreground">Ключевые различия</h2>
      <ul className="mt-3 flex flex-col gap-2.5">
        {differences.map((d, i) => {
          const Icon = d.icon;
          return (
            <li
              key={i}
              className="flex items-center gap-3 rounded-korpus border border-border bg-muted/40 px-3 py-2.5"
            >
              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                  DIFF_TONE[d.tone],
                )}
              >
                <Icon className="h-4 w-4" strokeWidth={2} />
              </span>
              <span className="text-[13px] leading-snug text-foreground">{d.text}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// --- Delta cell -------------------------------------------------------------------

/** Coloured change cell: green (good) / red (bad) with up/down arrow keyed off the sign. */
function ChangeCell({ tone, text }: { tone: DeltaTone; text: string }) {
  const negative = text.trim().startsWith("−") || text.trim().startsWith("-");
  const Arrow = negative ? ArrowDownRight : ArrowUpRight;
  const colour = tone === "up" ? "text-korpus-up" : tone === "down" ? "text-korpus-down" : "text-muted-foreground";
  return (
    <span className={cn("inline-flex items-center gap-1 font-semibold", colour)}>
      <span>{text}</span>
      {tone !== "neutral" && <Arrow className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />}
    </span>
  );
}

// --- Summary table ----------------------------------------------------------------

function SummaryTable({ rows }: { rows: SummaryRow[] }) {
  return (
    <section
      aria-label="Сводные показатели"
      className="flex flex-col rounded-korpus border border-border bg-card p-6 shadow-sm"
    >
      <h2 className="text-lg font-semibold text-foreground">Сводные показатели</h2>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-border text-xs font-medium text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">Метрика</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Раньше</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Позже</th>
              <th scope="col" className="py-2 text-right font-medium">Изменение</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const Icon = row.icon;
              return (
                <tr key={row.metric} className="border-b border-border/60 last:border-0">
                  <td className="py-3 pr-3">
                    <span className="flex items-center gap-2 text-foreground">
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                      <span>{row.metric}</span>
                    </span>
                  </td>
                  <td className="py-3 pr-3 text-right font-semibold text-foreground">{row.group1}</td>
                  <td className="py-3 pr-3 text-right font-semibold text-foreground">{row.group2}</td>
                  <td className="py-3 text-right">
                    <ChangeCell tone={row.changeTone} text={row.change} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// --- Directions panel (horizontal bar charts) -------------------------------------

function DirectionsPanel({ directions }: { directions: DirectionBar[] }) {
  return (
    <section
      aria-label="Сравнение по ключевым направлениям"
      className="flex flex-col rounded-korpus border border-border bg-card p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">Сравнение по ключевым направлениям</h2>
        <div className="flex items-center gap-4 text-xs font-medium text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: GROUP1_BLUE }} aria-hidden />
            Раньше
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: GROUP2_GREEN }} aria-hidden />
            Позже
          </span>
        </div>
      </div>
      <ul className="mt-5 flex flex-col gap-5">
        {directions.map((d) => (
          <li key={d.label}>
            <p className="text-[13px] font-medium text-foreground">{d.label}</p>
            <DirectionBars data={d} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Two stacked horizontal bars (Анализ 1 blue over Анализ 2 green) via Recharts. */
function DirectionBars({ data }: { data: DirectionBar }) {
  const max = data.isCount ? Math.max(data.group1, data.group2, 1) * 1.15 : 100;
  const suffix = data.isCount ? "" : "%";
  const rows = [
    { name: "Раньше", value: data.group1, fill: GROUP1_BLUE },
    { name: "Позже", value: data.group2, fill: GROUP2_GREEN },
  ];
  return (
    <div
      className="mt-1.5 h-[58px] w-full"
      aria-label={`${data.label}: Раньше ${data.group1}${suffix}, Позже ${data.group2}${suffix}`}
    >
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={58}>
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 2, right: 36, bottom: 2, left: 0 }}
          barCategoryGap={6}
        >
          <XAxis type="number" domain={[0, max]} hide />
          <YAxis type="category" dataKey="name" hide />
          <Bar dataKey="value" radius={[4, 4, 4, 4]} maxBarSize={14} isAnimationActive={false}>
            <LabelList
              dataKey="value"
              position="right"
              formatter={(v: number) => `${v}${suffix}`}
              style={{ fontSize: 11, fill: "hsl(220 28% 15%)", fontWeight: 600 }}
            />
            {rows.map((r, i) => (
              <Cell key={i} fill={r.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// --- ИИ-комментарий к сравнению ----------------------------------------------------

const AI_TONE: Record<AiComment["tone"], string> = {
  blue: "bg-korpus-blue/10 text-korpus-blue",
  orange: "bg-orange-100 text-orange-600",
  green: "bg-korpus-up/10 text-korpus-up",
};

function AiCommentCard({ comments }: { comments: AiComment[] }) {
  return (
    <section
      aria-label="Автоматические выводы по сравнению"
      className="flex flex-col rounded-korpus border border-korpus-blue/30 bg-korpus-blue/5 p-6 shadow-sm"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 shrink-0 text-korpus-blue" strokeWidth={2} />
        <h2 className="text-lg font-semibold text-korpus-blue">Автоматические выводы</h2>
      </div>
      <ul className="mt-5 flex flex-col gap-5">
        {comments.map((c) => {
          const Icon = c.icon;
          return (
            <li key={c.title} className="flex gap-3">
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                  AI_TONE[c.tone],
                )}
              >
                <Icon className="h-4 w-4" strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-foreground">{c.title}</h3>
                <p className="mt-1 text-[13px] leading-snug text-muted-foreground">{c.body}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// --- Детальное сравнение метрик ----------------------------------------------------

function DetailTable({ rows }: { rows: DetailRow[] }) {
  return (
    <section
      aria-label="Детальное сравнение метрик"
      className="flex flex-col rounded-korpus border border-border bg-card p-6 shadow-sm"
    >
      <h2 className="text-lg font-semibold text-foreground">Детальное сравнение метрик</h2>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-border text-xs font-medium text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">Метрика</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Раньше</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Позже</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Изменение</th>
              <th scope="col" className="py-2 font-medium">Комментарий</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={`${row.metric}-${i}`} className="border-b border-border/60 last:border-0">
                <td className="py-3 pr-3 text-foreground">{row.metric}</td>
                <td className="py-3 pr-3 text-right font-semibold text-foreground">{row.group1}</td>
                <td className="py-3 pr-3 text-right font-semibold text-foreground">{row.group2}</td>
                <td className="py-3 pr-3 text-right">
                  <ChangeCell tone={row.changeTone} text={row.change} />
                </td>
                <td className="py-3 text-muted-foreground">{row.comment}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// --- Что сделать методисту дальше --------------------------------------------------

function NextStepsCard({ steps }: { steps: string[] }) {
  return (
    <section
      aria-label="Что сделать методисту дальше"
      className="flex flex-col rounded-korpus border border-border bg-card p-6 shadow-sm"
    >
      <div className="flex items-center gap-2">
        <ClipboardCheck className="h-5 w-5 shrink-0 text-korpus-blue" strokeWidth={2} />
        <h2 className="text-lg font-semibold text-foreground">Что сделать методисту дальше</h2>
      </div>
      <ol className="mt-4 flex flex-col gap-3">
        {steps.map((step, i) => (
          <li
            key={i}
            className="flex items-center gap-3 rounded-korpus border border-border bg-muted/40 px-3 py-3"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-korpus-blue text-xs font-bold text-white">
              {i + 1}
            </span>
            <span className="flex-1 text-[13px] leading-snug text-foreground">{step}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// --- Action buttons ----------------------------------------------------------------

function ActionBar({ onDiscuss }: { onDiscuss: () => void }) {
  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={onDiscuss}
        className="flex w-full items-center gap-3 rounded-korpus border border-border bg-muted/50 px-5 py-3 text-left transition-colors hover:bg-muted sm:max-w-xl"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-korpus-blue/10 text-korpus-blue">
          <MessageCircle className="h-5 w-5" strokeWidth={1.75} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-foreground">Обсудить сравнение в чате</span>
          <span className="block text-xs text-muted-foreground">
            Спросите агента о различиях и получите рекомендации
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
}
