// web/frontend/src/screens/Results.tsx
// "Результаты" screen — 1:1 to the designer mockup "Результаты анализа".
// LAYOUT/STYLING preserved; this file adds DATA WIRING: it loads a real run and renders
// the saved report into the existing layout. Run selection:
//   - ?run=<id> in the URL (set by «Новый анализ» / «История»), else the latest from GET /runs;
//     a picker in the header switches between saved analyses.
//   - GET /runs/{id} → the full result; deltas come ONLY from the previous analysis of the
//     SAME course (lib/runs.previousComparable) — never from an unrelated run.
// Sections (top → bottom), all populated from the run:
//   1. Header (title, which analysis this is, run picker)
//   2. Data-quality plate (unreadable files / groups skipped) + «Что мы поняли в ваших файлах»
//   3. "Курс требует внимания" warning banner (shown only when warnings/risks exist)
//   4. A row of 6 metric cards, each with a delta vs the previous analysis of the course
//   5. "ИИ-выводы" — insight cards from result.insights.commentary + a blue CTA card
//   6. "Критические вопросы" (answer.questions) and "Анализ попыток" (time)
//   7. Collapsible "Текстовый отчёт" — built from the data, with or without AI
// «Уточнить у агента» creates a thread bound to this run (POST /threads) and opens /chat.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Users,
  FileQuestion,
  Gauge,
  Target,
  Clock,
  AlertTriangle,
  Activity,
  HelpCircle,
  Lightbulb,
  ShieldAlert,
  Sparkles,
  Bot,
  UserRound,
  BarChart3,
  FileText,
  ChevronDown,
  Download,
  ArrowUp,
  ArrowDown,
  Minus,
  Loader2,
  Inbox,
  Info,
  type LucideIcon,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  Cell,
  LabelList,
  Tooltip,
} from "recharts";
import { Button } from "@/components/ui/button";
import {
  getRun,
  listRuns,
  createThread,
  downloadReport,
  type AnalysisResult,
  type ReportKind,
  type RunMeta,
} from "@/api/client";
import { cn } from "@/lib/utils";
import { normalizeAiText, parseAiBlock, type AiItem } from "@/lib/aiText";
import {
  count,
  courseLabel,
  formatDate,
  formatDateTime,
  previousComparable,
  runTitle,
} from "@/lib/runs";

// --- Backend result shapes (web/service.run_analysis → core.history report.json) -----
// Minimal mirrors of the fields this screen reads. Everything is optional/defensive:
// older runs may lack `time`, `insights`, `input_report` or some `summary` fields.

interface Summary {
  total_users?: number | null;
  total_questions?: number | null;
  avg_score?: number | null;
  real_attempts?: number | null;
  abandoned?: number | null;
}

interface CommonError {
  answer?: string;
  count?: number;
}

interface Question {
  question_text?: string;
  correct_rate?: number; // 0..1
  critical?: boolean;
  type?: string;
  answered?: number;
  correct_answer?: string;
  key_suspect?: { answer?: string; share?: number };
  common_errors?: CommonError[];
  tests?: string[]; // tests (sheets) this merged question spans (R2-8)
}

interface AnswerBlock {
  summary?: Summary;
  questions?: Question[];
}

interface TimeTest {
  test_name?: string;
  attempts?: number;
  median_score?: number; // 0..100
}

interface AttemptAnomaly {
  student_id?: string;
  attempts?: number;
  score_min?: number;
  score_max?: number;
  reason?: string;
}

interface StudentRow {
  student_id?: string;
  best_score?: number | null;
  attempts?: number;
  status?: string;
}

interface TimeBlock {
  tests?: TimeTest[];
  attempt_anomalies?: AttemptAnomaly[];
  students?: StudentRow[];
  abandoned_rate?: number; // percent
}

interface Commentary {
  blocks?: Record<string, string>;
  custom?: string | null;
}

interface Suggestion {
  message?: string;
}

interface Insights {
  commentary?: Commentary;
  suggestions?: { gaps?: Suggestion[]; narrative?: string | null };
}

/** One group's slice of a multi-group run (web/service.run_analysis groups[]). */
interface GroupResult {
  label?: string;
  name?: string;
  answer?: AnswerBlock;
  time?: TimeBlock;
}

/** «Что мы поняли в ваших файлах» — web/service._input_report. */
interface InputReport {
  answer_files?: number;
  answer_files_used?: number;
  groups_total?: number;
  groups_used?: number;
  has_reference?: boolean;
  reference_name?: string | null;
  skipped?: { file?: string; reason?: string }[];
  notes?: string[];
  limitations?: string[];
}

interface RunResult extends AnalysisResult {
  answer?: AnswerBlock;
  time?: TimeBlock;
  insights?: Insights;
  warnings?: string[];
  groups?: GroupResult[];
  input_report?: InputReport;
}

/** Orientation score under which the course is flagged «ниже ориентира» (shown to the user). */
const TARGET_SCORE = 75;
/** A question is critical when fewer than this share answered correctly (config: critical_correct_rate). */
const CRITICAL_PERCENT = 50;
/** Below this share of correct answers the risk is «Высокий» (else «Повышенный»). */
const HIGH_RISK_PERCENT = 35;

// --- Derivation: turn one saved run into the props the layout already renders -------

type DeltaTone = "up" | "down" | "neutral";

interface Metric {
  icon: LucideIcon;
  tone: "blue" | "green" | "orange" | "red";
  label: string;
  value: string;
  /** Delta line vs the previous analysis of the same course; absent when there is nothing to compare. */
  delta?: string;
  deltaTone?: DeltaTone;
}

const NO_CHANGE = "без изменений";

/** Count critical questions in a run's answer block. */
function criticalCount(answer: AnswerBlock | undefined): number {
  return (answer?.questions ?? []).filter((q) => q.critical).length;
}

/** Abandoned share as a 0..100 percent (abandoned / (real + abandoned)). */
function abandonedPercent(s: Summary | undefined, time: TimeBlock | undefined): number | null {
  if (time && typeof time.abandoned_rate === "number") return time.abandoned_rate;
  const real = s?.real_attempts ?? 0;
  const abandoned = s?.abandoned ?? 0;
  const total = real + abandoned;
  if (total <= 0) return null;
  return Math.round((abandoned / total) * 100);
}

/** Format a count delta as a Russian "+N / −N к прошлому анализу" line (neutral at 0). */
function countDelta(
  now: number | null | undefined,
  prev: number | null | undefined,
): { text: string; tone: DeltaTone } | undefined {
  if (now == null || prev == null) return undefined;
  const d = now - prev;
  if (d === 0) return { text: NO_CHANGE, tone: "neutral" };
  const sign = d > 0 ? "+" : "−";
  return { text: `${sign}${Math.abs(d)} к прошлому анализу`, tone: d > 0 ? "up" : "down" };
}

/** Format a percentage-point delta line; `goodWhenUp` decides green vs red colouring. */
function ppDelta(
  now: number | null | undefined,
  prev: number | null | undefined,
  goodWhenUp: boolean,
): { text: string; tone: DeltaTone } | undefined {
  if (now == null || prev == null) return undefined;
  const d = Math.round((now - prev) * 10) / 10;
  if (d === 0) return { text: NO_CHANGE, tone: "neutral" };
  const sign = d > 0 ? "+" : "−";
  const up = d > 0;
  const good = goodWhenUp ? up : !up;
  return {
    text: `${sign}${Math.abs(d)} п.п. к прошлому анализу`,
    tone: good ? "up" : "down",
  };
}

/** Abandoned % of a saved run's summary (the index carries real_attempts + abandoned). */
function priorAbandoned(prior: RunMeta["summary"] | null): number | null {
  if (!prior || prior.real_attempts == null || prior.abandoned == null) return null;
  const total = prior.real_attempts + prior.abandoned;
  return total > 0 ? Math.round((prior.abandoned / total) * 100) : null;
}

function buildMetrics(result: RunResult, prior: RunMeta["summary"] | null): Metric[] {
  const s = result.answer?.summary ?? {};
  const crit = criticalCount(result.answer);
  const abandoned = abandonedPercent(s, result.time);
  const avg = typeof s.avg_score === "number" ? s.avg_score : null;

  const usersDelta = prior ? countDelta(s.total_users ?? null, prior.total_users) : undefined;
  const questionsDelta = prior ? countDelta(s.total_questions ?? null, prior.total_questions) : undefined;
  const avgDelta = prior ? ppDelta(avg, prior.avg_score, true) : undefined;
  const critDelta = prior ? countDelta(crit, prior.critical) : undefined;
  const attemptsDelta = prior ? countDelta(s.real_attempts ?? null, prior.real_attempts) : undefined;
  // Lower abandoned is better.
  const abandonedDelta = prior ? ppDelta(abandoned, priorAbandoned(prior), false) : undefined;
  return [
    {
      icon: Users,
      tone: "blue",
      label: "Пользователи",
      value: s.total_users != null ? String(s.total_users) : "—",
      delta: usersDelta?.text,
      deltaTone: usersDelta?.tone,
    },
    {
      icon: FileQuestion,
      tone: "blue",
      label: "Вопросы",
      value: s.total_questions != null ? String(s.total_questions) : "—",
      delta: questionsDelta?.text,
      deltaTone: questionsDelta?.tone,
    },
    {
      icon: Gauge,
      tone: "green",
      label: "Средний балл",
      value: avg != null ? `${Math.round(avg)}%` : "—",
      delta: avgDelta?.text,
      deltaTone: avgDelta?.tone,
    },
    {
      icon: Target,
      tone: "blue",
      label: "Реальные попытки",
      value: s.real_attempts != null ? String(s.real_attempts) : "—",
      delta: attemptsDelta?.text,
      deltaTone: attemptsDelta?.tone,
    },
    {
      icon: Clock,
      tone: "orange",
      label: "Брошенные попытки",
      value: abandoned != null ? `${abandoned}%` : "—",
      delta: abandonedDelta?.text,
      deltaTone: abandonedDelta?.tone,
    },
    {
      icon: AlertTriangle,
      tone: "red",
      label: "Критические вопросы",
      value: String(crit),
      delta: critDelta?.text,
      deltaTone: critDelta?.tone,
    },
  ];
}

// ИИ-выводы: each commentary block key maps to a titled, icon'd full-width block. Block text is
// split into paragraphs (prose) and bullets (list lines), see lib/aiText.parseAiBlock.
interface Insight {
  icon: LucideIcon;
  tone: "blue" | "orange" | "green" | "red";
  title: string;
  items: AiItem[];
}

const INSIGHT_BLOCK_META: Record<string, { icon: LucideIcon; tone: Insight["tone"]; title: string }> = {
  diagnosis: { icon: Activity, tone: "blue", title: "Коротко о результатах" },
  why_failed: { icon: HelpCircle, tone: "orange", title: "Почему вопросы провалены" },
  recommendations: { icon: Lightbulb, tone: "green", title: "Рекомендации" },
  anomalies: { icon: ShieldAlert, tone: "red", title: "Аномалии и риски" },
};
const INSIGHT_BLOCK_ORDER = ["diagnosis", "why_failed", "recommendations", "anomalies"] as const;

function buildInsights(result: RunResult): Insight[] {
  const blocks = result.insights?.commentary?.blocks ?? {};
  const custom = result.insights?.commentary?.custom;
  const out: Insight[] = [];
  for (const key of INSIGHT_BLOCK_ORDER) {
    const text = blocks[key];
    if (text && text.trim()) {
      const meta = INSIGHT_BLOCK_META[key];
      out.push({ icon: meta.icon, tone: meta.tone, title: meta.title, items: parseAiBlock(text) });
    }
  }
  if (custom && custom.trim()) {
    out.push({
      icon: Sparkles,
      tone: "blue",
      title: "Ответ на ваш запрос",
      items: parseAiBlock(custom),
    });
  }
  return out;
}

// Критические вопросы: rows from answer.questions where critical, sorted hardest-first.
type RiskLevel = "Высокий" | "Повышенный" | "Средний";

interface FrequentError {
  label: string;
  full: string;
  count: number;
}

interface CriticalQuestion {
  correctRate: number;
  question: string;
  tests: string[];
  correctAnswer: string | null;
  keySuspect: boolean;
  errors: FrequentError[];
  risk: RiskLevel;
  recommendation: string;
}

function riskFor(rate: number): RiskLevel {
  if (rate < HIGH_RISK_PERCENT) return "Высокий";
  if (rate < CRITICAL_PERCENT) return "Повышенный";
  return "Средний";
}

/** A recommendation by the KIND of problem, not one phrase for every row. */
function recommendationFor(q: Question): string {
  const share = q.key_suspect?.share;
  if (q.key_suspect) {
    const pct = typeof share === "number" ? `${Math.round(share * 100)}% отвечавших` : "большинство отвечавших";
    return `Проверить эталон: «неверный» ответ выбрали ${pct} — возможно, ключ ошибочен`;
  }
  if (prettyCorrect(q.correct_answer) === null) {
    return "В выгрузке нет правильного ответа — проверить эталон и формулировку вопроса";
  }
  if ((q.answered ?? 99) < 10) {
    return "Мало ответов — вывод ненадёжен, дождаться большего числа попыток";
  }
  const t = (q.type ?? "").toLowerCase();
  if (t.includes("текст") || t.includes("числов")) {
    return "Свободный ответ: уточнить допустимые формулировки в эталоне";
  }
  if ((q.common_errors ?? []).length >= 2) {
    return "Развести близкие варианты ответа и уточнить формулировку";
  }
  return "Вопрос трудный для аудитории: добавить пример или подготовительный материал";
}

/** Why the correct answer of a question is missing: the reference has no value for it. */
const NO_REFERENCE = "нет в эталоне";

/** Correct answer for display; null when the reference carries no value («», «; ; ;»). Blank
 *  parts of a multi-part answer read «нет в эталоне», never the user-facing «не заполнено»
 *  (that wording is for what a LEARNER left empty). */
function prettyCorrect(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const parts = t.split(/\s*;\s*/);
  if (parts.every((p) => !p.trim())) return null;
  return parts.map((p) => (p.trim() ? p.trim() : NO_REFERENCE)).join("; ");
}

/** Readable version of a stored answer: empty parts («; ; ;») become «не заполнено». */
function prettyAnswer(raw: string | undefined): string {
  const t = (raw ?? "").trim();
  if (!t) return "не заполнено";
  const parts = t.split(/\s*;\s*/);
  if (parts.length > 1 && parts.every((p) => !p.trim())) return "не заполнено";
  return parts.map((p) => (p.trim() ? p.trim() : "не заполнено")).join("; ");
}

function buildCriticalQuestions(result: RunResult): CriticalQuestion[] {
  const questions = (result.answer?.questions ?? []).filter((q) => q.critical);
  questions.sort((a, b) => (a.correct_rate ?? 0) - (b.correct_rate ?? 0));
  return questions.map((q) => {
    const rate = Math.round((q.correct_rate ?? 0) * 100);
    return {
      correctRate: rate,
      question: q.question_text ?? "—",
      tests: q.tests ?? [],
      correctAnswer: prettyCorrect(q.correct_answer),
      keySuspect: Boolean(q.key_suspect),
      errors: (q.common_errors ?? []).slice(0, 3).map((e) => {
        const full = prettyAnswer(e.answer);
        return { label: full, full, count: e.count ?? 0 };
      }),
      risk: riskFor(rate),
      recommendation: recommendationFor(q),
    };
  });
}

// Анализ попыток: stat cards, status breakdown, score distribution.
interface AttemptStat {
  id: "abandoned" | "anomalies" | "range";
  icon: LucideIcon;
  tone: "orange" | "blue";
  label: string;
  value: string;
  hint?: string;
}

/** Best score of each listener (0..100); falls back to nothing when the run has no roster. */
function studentScores(result: RunResult): number[] {
  return (result.time?.students ?? [])
    .map((s) => s.best_score)
    .filter((v): v is number => typeof v === "number");
}

/** Score samples for the distribution: per-listener best scores; for older runs without a
 *  roster, per-question correct rates (the chart then says so in its title). */
function scoreSamples(result: RunResult): { values: number[]; unit: "person" | "question" } {
  const people = studentScores(result);
  if (people.length) return { values: people, unit: "person" };
  const fromQuestions = (result.answer?.questions ?? [])
    .map((q) => q.correct_rate)
    .filter((v): v is number => typeof v === "number")
    .map((v) => v * 100);
  return { values: fromQuestions, unit: "question" };
}

function buildAttemptStats(result: RunResult): AttemptStat[] {
  const s = result.answer?.summary ?? {};
  const time = result.time;
  const abandoned = abandonedPercent(s, time);
  const anomalies = time?.attempt_anomalies?.length ?? 0;
  const total = s.total_users ?? time?.students?.length ?? null;
  const { values } = scoreSamples(result);
  const range =
    values.length > 0
      ? `${Math.round(Math.min(...values))}% – ${Math.round(Math.max(...values))}%`
      : "—";
  return [
    {
      id: "abandoned",
      icon: Clock,
      tone: "orange",
      label: "Брошенные попытки",
      value: abandoned != null ? `${abandoned}%` : "—",
    },
    {
      id: "anomalies",
      icon: UserRound,
      tone: "blue",
      label: "Слушатели с необычным ходом попыток",
      value: total ? `${anomalies} из ${total}` : String(anomalies),
      hint: anomalies > 0 ? "Нажмите, чтобы увидеть список" : undefined,
    },
    { id: "range", icon: BarChart3, tone: "blue", label: "Диапазон лучших баллов слушателей", value: range },
  ];
}

interface StatusRow {
  label: string;
  percent: number;
  count: number;
  tone: "blue" | "orange";
}

function buildStatusRows(result: RunResult): StatusRow[] {
  const s = result.answer?.summary ?? {};
  const real = s.real_attempts ?? 0;
  const abandoned = s.abandoned ?? 0;
  const total = real + abandoned;
  if (total <= 0) return [];
  return [
    {
      label: "Завершили",
      percent: Math.round((real / total) * 100),
      count: real,
      tone: "blue",
    },
    {
      label: "Бросили",
      percent: Math.round((abandoned / total) * 100),
      count: abandoned,
      tone: "orange",
    },
  ];
}

interface ScoreBucket {
  range: string;
  count: number;
  percent: number;
  peak?: boolean;
}

interface Distribution {
  buckets: ScoreBucket[];
  unit: "person" | "question";
}

/** Equal ten-point intervals, so bars are comparable at a glance. */
const BUCKET_BOUNDS: { range: string; lo: number; hi: number }[] = Array.from({ length: 10 }, (_, i) => ({
  range: `${i * 10}–${i * 10 + 10}`,
  lo: i * 10,
  hi: i === 9 ? 100.0001 : i * 10 + 10,
}));

function buildDistribution(result: RunResult): Distribution {
  const { values, unit } = scoreSamples(result);
  if (!values.length) return { buckets: [], unit };
  const counts = BUCKET_BOUNDS.map((b) => values.filter((v) => v >= b.lo && v < b.hi).length);
  const total = values.length;
  const peakIdx = counts.indexOf(Math.max(...counts));
  return {
    unit,
    buckets: BUCKET_BOUNDS.map((b, i) => ({
      range: b.range,
      count: counts[i],
      percent: Math.round((counts[i] / total) * 100),
      peak: i === peakIdx,
    })),
  };
}

/** Free-text report body, built from the DATA so it is useful with or without AI: the
 *  headline numbers, input problems, the hardest questions with the right answer and the
 *  typical mistakes, attempts findings and the data suggestions. AI commentary is shown in
 *  its own section above and is not repeated here. */
function buildReportText(result: RunResult, meta: RunMeta | null): string {
  const parts: string[] = [];
  const s = result.answer?.summary ?? {};
  const course = courseLabel({ course_id: result.course_id ?? meta?.course_id });
  const crit = (result.answer?.questions ?? []).filter((q) => q.critical);
  parts.push(
    `${course ? `${course}: ` : ""}${count(s.total_users ?? 0, "слушатель", "слушателя", "слушателей")}, ` +
      `${count(s.total_questions ?? 0, "вопрос", "вопроса", "вопросов")}, средний балл ${
        s.avg_score != null ? `${Math.round(s.avg_score)}%` : "—"
      }. Критических вопросов (верно меньше ${CRITICAL_PERCENT}%): ${crit.length}.`,
  );

  const rep = result.input_report;
  const problems: string[] = [];
  if (rep?.groups_total) problems.push(`Учтено групп: ${rep.groups_used ?? 0} из ${rep.groups_total}.`);
  for (const d of rep?.skipped ?? []) problems.push(skipLine(d));
  for (const l of rep?.limitations ?? []) problems.push(l);
  if (problems.length) parts.push(problems.join("\n"));

  const hardest = [...crit].sort((a, b) => (a.correct_rate ?? 0) - (b.correct_rate ?? 0)).slice(0, 8);
  if (hardest.length) {
    const lines = hardest.map((q) => {
      const rate = Math.round((q.correct_rate ?? 0) * 100);
      const errs = (q.common_errors ?? [])
        .slice(0, 2)
        .map((e) => `«${prettyAnswer(e.answer)}» ×${e.count ?? 0}`)
        .join(", ");
      return (
        `• [${rate}% верных] ${q.question_text ?? "—"}` +
        (prettyCorrect(q.correct_answer) ? ` — верный ответ: ${prettyCorrect(q.correct_answer)}` : "") +
        (errs ? `; частые ошибки: ${errs}` : "") +
        (q.key_suspect ? " — ВОЗМОЖНА ОШИБКА В ЭТАЛОНЕ" : "")
      );
    });
    parts.push(`Самые трудные вопросы:\n${lines.join("\n")}`);
  }

  const an = result.time?.attempt_anomalies?.length ?? 0;
  if (an > 0) {
    parts.push(
      `Слушателей с необычным ходом попыток: ${an}. Подробности — в блоке «Анализ попыток» выше.`,
    );
  }

  const gaps = (result.insights?.suggestions?.gaps ?? [])
    .map((g) => g.message)
    .filter((m): m is string => Boolean(m && m.trim()));
  const narrative = normalizeAiText(result.insights?.suggestions?.narrative);
  if (gaps.length || narrative) {
    parts.push(`Рекомендации по данным:\n${[narrative, ...gaps.map((g) => `• ${g}`)].filter(Boolean).join("\n")}`);
  }
  return parts.join("\n\n");
}

/** Warning-banner copy: built from the run's warnings/gaps and risk counts when present. */
function buildWarning(result: RunResult): string | null {
  const reasons: string[] = [];
  const avg = result.answer?.summary?.avg_score;
  const qs = (result.answer?.questions ?? []).filter((q) => q.critical);
  if (typeof avg === "number" && avg < TARGET_SCORE) {
    reasons.push(`средний балл ${Math.round(avg)}% ниже ориентира ${TARGET_SCORE}%`);
  }
  if (qs.length > 0) {
    const high = qs.filter((q) => Math.round((q.correct_rate ?? 0) * 100) < HIGH_RISK_PERCENT).length;
    reasons.push(
      `${count(qs.length, "критический вопрос", "критических вопроса", "критических вопросов")} ` +
        `(верно меньше ${CRITICAL_PERCENT}%): ${high} с высоким риском, ${qs.length - high} с повышенным`,
    );
  }
  const lowSample = (result.insights?.suggestions?.gaps ?? []).some((g) =>
    (g.message ?? "").includes("мало ответов"),
  );
  if (lowSample) reasons.push("часть выводов ограничена малой выборкой");
  if (!reasons.length) return null;
  return `${reasons.join("; ")}.`.replace(/^./, (ch) => ch.toUpperCase());
}

/** Short «what is this analysis» line under the title. */
function describeRun(meta: RunMeta | null, result: RunResult): string {
  const parts: string[] = [];
  const course = courseLabel({ course_id: result.course_id ?? meta?.course_id });
  parts.push(course ?? "Курс не определён по названиям файлов");
  const groups = (result.groups ?? []).map((g) => g.label).filter(Boolean) as string[];
  if (groups.length) parts.push(count(groups.length, "группа", "группы", "групп"));
  if (meta) parts.push(formatDateTime(meta.created_at));
  const rep = result.input_report;
  if (rep?.answer_files != null) {
    const skipped = (rep.skipped ?? []).length;
    parts.push(
      `${count(rep.answer_files, "файл", "файла", "файлов")}${skipped ? ` (${skipped} не учтено)` : ""}`,
    );
  }
  if (rep?.has_reference != null) parts.push(`эталон: ${rep.has_reference ? "есть" : "нет"}`);
  return parts.join(" · ");
}

/** «Файл «x» повреждён…» already names the file; other reasons get the «не учтён» prefix. */
function skipLine(d: { file?: string; reason?: string }): string {
  const reason = d.reason ?? "";
  return reason.includes(`«${d.file}»`) ? reason : `Файл «${d.file}» не учтён: ${reason}`;
}

// --- Screen -----------------------------------------------------------------------

type LoadState =
  | { phase: "loading" }
  | { phase: "empty" }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      result: RunResult;
      runId: string;
      runs: RunMeta[];
      meta: RunMeta | null;
      prior: RunMeta | null;
    };

export function Results() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const requestedRun = params.get("run");

  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [reportOpen, setReportOpen] = useState(false);
  const [anomaliesOpen, setAnomaliesOpen] = useState(false);
  // Selected scope for a multi-group run: -1 = «Все группы», 0..n-1 = a specific group.
  const [groupIdx, setGroupIdx] = useState(-1);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    setGroupIdx(-1); // a freshly loaded run starts on «Все группы»
    setAnomaliesOpen(false);

    (async () => {
      try {
        const runs = await listRuns();
        if (cancelled) return;
        if (!runs.length && !requestedRun) {
          setState({ phase: "empty" });
          return;
        }
        // Use the URL run id if present, else the latest run (index is newest-first).
        const targetId = requestedRun ?? runs[0].id;
        const meta = runs.find((r) => r.id === targetId) ?? null;
        // Deltas («к прошлому анализу») only make sense vs the previous run of the SAME
        // course (and group set when possible) — comparing different courses is meaningless.
        const prior = previousComparable(runs, targetId);

        const result = (await getRun(targetId)) as RunResult;
        if (cancelled) return;
        setState({ phase: "ready", result, runId: targetId, runs, meta, prior });
      } catch (e) {
        if (cancelled) return;
        setState({
          phase: "error",
          message: e instanceof Error ? e.message : "Не удалось загрузить результаты анализа.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [requestedRun]);

  // «Уточнить у агента»: bind a thread to this run and open chat.
  const openChat = useCallback(async () => {
    const runId = state.phase === "ready" ? state.runId : null;
    let threadId: string | null = null;
    try {
      if (runId) {
        const t = await createThread({ title: "Вопрос по анализу", category: "Анализ", context: { run_id: runId } });
        threadId = t.id;
      }
    } catch {
      /* Best-effort: still open the chat even if thread creation fails. */
    }
    // Pass the new thread so the chat opens it bound (not the demo state).
    navigate(threadId ? `/chat?thread=${threadId}` : "/chat");
  }, [state, navigate]);

  // «Скачать Word / PDF»: fetch → blob, so a failure shows a Russian message instead of a dead tab.
  const [downloading, setDownloading] = useState<ReportKind | null>(null);
  const [downloadNote, setDownloadNote] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const download = useCallback(
    async (kind: ReportKind) => {
      if (state.phase !== "ready" || downloading) return;
      setDownloading(kind);
      setDownloadNote(null);
      try {
        const how = await downloadReport(state.runId, kind);
        if (how === "html") {
          setDownloadNote({
            tone: "info",
            text: "PDF не создан автоматически (не найден браузер для печати). Открыт печатный вариант: нажмите Ctrl+P и выберите «Сохранить как PDF».",
          });
        }
      } catch (e) {
        setDownloadNote({ tone: "error", text: e instanceof Error ? e.message : "Не удалось скачать отчёт." });
      } finally {
        setDownloading(null);
      }
    },
    [state, downloading],
  );

  if (state.phase === "loading") {
    return (
      <CenteredNotice>
        <Loader2 className="h-8 w-8 animate-spin text-korpus-blue" strokeWidth={2} />
        <p className="mt-4 text-base text-muted-foreground">Загружаем результаты анализа…</p>
      </CenteredNotice>
    );
  }

  if (state.phase === "error") {
    return (
      <CenteredNotice>
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-korpus-down/10 text-korpus-down">
          <AlertTriangle className="h-6 w-6" strokeWidth={2} />
        </span>
        <p className="mt-4 text-base font-semibold text-foreground">Не удалось загрузить анализ</p>
        <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
      </CenteredNotice>
    );
  }

  if (state.phase === "empty") {
    return (
      <CenteredNotice>
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-korpus-blue/10 text-korpus-blue">
          <Inbox className="h-6 w-6" strokeWidth={1.75} />
        </span>
        <p className="mt-4 text-base font-semibold text-foreground">Пока нет ни одного анализа</p>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          Запустите анализ на вкладке «Новый анализ» — результаты появятся здесь.
        </p>
        <Button type="button" className="mt-5 h-11" onClick={() => navigate("/")}>
          <Sparkles className="h-[18px] w-[18px]" strokeWidth={2} />
          Запустить первый анализ
        </Button>
      </CenteredNotice>
    );
  }

  const { result, prior, runs, meta, runId } = state;
  const groups = result.groups ?? [];
  // Scope the per-question/metric views to the selected group; «Все группы» (-1) uses the
  // pooled top-level result. Deltas only make sense on «Все группы» (vs the previous run);
  // ИИ-выводы + the text report stay combined (they describe the whole analysis).
  const inGroup = groupIdx >= 0 && Boolean(groups[groupIdx]);
  const scoped: RunResult = inGroup
    ? { ...result, answer: groups[groupIdx].answer, time: groups[groupIdx].time }
    : result;
  const scopedPrior = inGroup ? null : prior;

  const metrics = buildMetrics(scoped, scopedPrior?.summary ?? null);
  const insights = buildInsights(result);
  const criticalQuestions = buildCriticalQuestions(scoped);
  const attemptStats = buildAttemptStats(scoped);
  const statusRows = buildStatusRows(scoped);
  const distribution = buildDistribution(scoped);
  const reportText = buildReportText(result, meta);
  const warning = buildWarning(scoped);
  const anomalies = scoped.time?.attempt_anomalies ?? [];

  return (
    <div className="h-full overflow-y-auto bg-background font-korpus">
      <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-8 sm:py-8">
        {/* 1. Header */}
        <header>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <h1 className="text-[28px] font-bold leading-tight tracking-tight text-foreground sm:text-[40px]">
              Результаты анализа
            </h1>
            {runs.length > 1 && (
              <label className="flex min-w-0 max-w-full flex-col gap-1 text-sm text-muted-foreground">
                <span>Показан анализ</span>
                <select
                  aria-label="Выбрать анализ"
                  value={runId}
                  onChange={(e) => setParams({ run: e.target.value })}
                  className="h-10 max-w-[420px] truncate rounded-korpus border border-border bg-card px-3 text-sm text-foreground"
                >
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {runTitle(r)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <p className="mt-2 text-sm font-medium text-foreground" data-testid="run-descriptor">
            {describeRun(meta, result)}
          </p>
          <p className="mt-1 text-base text-muted-foreground">
            {insights.length > 0
              ? "ИИ обработал данные тестирования и выделил ключевые проблемы, риски и рекомендации"
              : "Расчёт по данным тестирования: ключевые проблемы, риски и данные для решений"}
          </p>
          <div aria-label="Действия с результатами" role="group" className="mt-4 flex flex-wrap items-center gap-3">
            <Button type="button" className="h-10" onClick={openChat}>
              <Bot className="h-[18px] w-[18px]" strokeWidth={1.75} />
              Уточнить у агента
            </Button>
            <Button type="button" variant="outline" className="h-10" onClick={() => void download("docx")} disabled={downloading !== null}>
              {downloading === "docx" ? (
                <Loader2 className="h-[18px] w-[18px] animate-spin" strokeWidth={2} />
              ) : (
                <FileText className="h-[18px] w-[18px]" strokeWidth={1.75} />
              )}
              Скачать Word
            </Button>
            <Button type="button" variant="outline" className="h-10" onClick={() => void download("pdf")} disabled={downloading !== null}>
              {downloading === "pdf" ? (
                <Loader2 className="h-[18px] w-[18px] animate-spin" strokeWidth={2} />
              ) : (
                <Download className="h-[18px] w-[18px]" strokeWidth={1.75} />
              )}
              Скачать PDF
            </Button>
          </div>
          {downloadNote && (
            <p
              role={downloadNote.tone === "error" ? "alert" : "status"}
              className={cn("mt-3 text-sm", downloadNote.tone === "error" ? "text-korpus-down" : "text-muted-foreground")}
            >
              {downloadNote.text}
            </p>
          )}
        </header>

        {/* 2. Data quality: what was (not) read from the uploaded files. */}
        <InputPlate result={result} />

        {/* 3. Warning banner — only when the run actually signals risk. */}
        {warning && (
          <section
            role="alert"
            className="mt-6 flex items-start gap-4 rounded-korpus border border-orange-200 bg-orange-50 p-5"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-orange-100 text-orange-600">
              <AlertTriangle className="h-5 w-5" strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <p className="text-base font-semibold text-foreground">Курс требует внимания</p>
              <p className="mt-1 text-sm text-muted-foreground">{warning}</p>
            </div>
          </section>
        )}

        {/* 3.5 Group switcher — only for a multi-group run (one run, per-group breakdown). */}
        {groups.length > 0 && (
          <section aria-label="Группы" className="mt-6 flex flex-wrap items-center gap-2">
            <GroupPill label="Все группы" active={!inGroup} onClick={() => setGroupIdx(-1)} />
            {groups.map((g, i) => (
              <GroupPill
                key={`${g.name ?? g.label ?? i}`}
                label={g.label ?? `Группа ${i + 1}`}
                active={inGroup && groupIdx === i}
                onClick={() => setGroupIdx(i)}
              />
            ))}
          </section>
        )}

        {/* 4. Metric cards */}
        <section
          aria-label="Ключевые метрики"
          className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6"
        >
          {metrics.map((m) => (
            <MetricCard key={m.label} metric={m} />
          ))}
        </section>
        <p className="mt-2 text-sm text-muted-foreground" data-testid="delta-basis">
          {inGroup ? (
            <>Показаны данные одной группы; сравнение с прошлым анализом — на вкладке «Все группы».</>
          ) : prior ? (
            <>
              Изменения посчитаны к анализу{" "}
              <Link
                to={`/results?run=${prior.id}`}
                className="font-medium text-korpus-blue hover:underline"
              >
                «{prior.name}» от {formatDate(prior.created_at)}
              </Link>{" "}
              (тот же курс).
            </>
          ) : (
            <>Нет предыдущего анализа этого курса — сравнивать пока не с чем.</>
          )}
        </p>

        {/* 5. ИИ-выводы */}
        <section aria-label="ИИ-выводы" className="mt-8">
          <h2 className="text-lg font-semibold text-foreground">ИИ-выводы</h2>
          {inGroup && insights.length > 0 && (
            <p className="mt-1 text-sm text-muted-foreground">
              Выводы ИИ ниже относятся ко всем группам вместе; цифры и таблицы — к выбранной группе.
            </p>
          )}
          {insights.length > 0 ? (
            <div className="mt-4 flex flex-col gap-4">
              {insights.map((insight) => (
                <InsightBlock key={insight.title} insight={insight} />
              ))}
            </div>
          ) : (
            <article className="mt-4 flex flex-wrap items-center gap-3 rounded-korpus border border-korpus-blue/20 bg-korpus-blue/5 px-5 py-3 text-sm text-muted-foreground">
              <span className="min-w-0 flex-[1_1_16rem]">
                Глубокий анализ с ИИ был выключен для этого анализа. Включите его в настройках и
                запустите новый анализ, чтобы получить ИИ-комментарий.
              </span>
              <Button type="button" variant="outline" size="sm" onClick={() => navigate("/settings")}>
                Открыть настройки
              </Button>
            </article>
          )}
        </section>

        {/* 6. Critical questions table + attempts panel */}
        <div className="mt-8 flex flex-col gap-6">
          <CriticalQuestionsTable questions={criticalQuestions} />
          <AttemptsPanel
            stats={attemptStats}
            statusRows={statusRows}
            distribution={distribution}
            anomalies={anomalies}
            anomaliesOpen={anomaliesOpen}
            onToggleAnomalies={() => setAnomaliesOpen((v) => !v)}
            totalListeners={scoped.answer?.summary?.total_users ?? null}
          />
        </div>

        {/* 7. Collapsible text report */}
        <TextReport
          open={reportOpen}
          onToggle={() => setReportOpen((v) => !v)}
          body={reportText}
        />
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

// --- Input plate: what the engine understood in the uploaded files -----------------

function InputPlate({ result }: { result: RunResult }) {
  const rep = result.input_report;
  const skipped = rep?.skipped ?? [];
  // Older runs have no structured report: fall back to warnings that name an unreadable file.
  const legacySkipped = rep
    ? []
    : (result.warnings ?? []).filter((w) => /повреждён|не удалось открыть/i.test(w));
  const groupsTotal = rep?.groups_total ?? 0;
  const groupsUsed = rep?.groups_used ?? 0;
  const lostGroups = groupsTotal > 0 && groupsUsed < groupsTotal;
  const hasProblem = skipped.length > 0 || legacySkipped.length > 0 || lostGroups;
  const notes = rep?.notes ?? [];
  const limitations = rep?.limitations ?? [];
  const otherWarnings = (result.warnings ?? []).filter(
    (w) => !legacySkipped.includes(w) && !skipped.some((d) => w === d.reason),
  );
  const hasDetails = Boolean(rep) || otherWarnings.length > 0;
  if (!hasProblem && !hasDetails) return null;

  return (
    <div className="mt-6 flex flex-col gap-3">
      {hasProblem && (
        <section
          role="alert"
          aria-label="Не все данные учтены"
          className="flex items-start gap-4 rounded-korpus border border-amber-300 bg-amber-50 p-5"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700">
            <AlertTriangle className="h-5 w-5" strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <p className="text-base font-semibold text-foreground">
              {lostGroups
                ? `Учтено групп: ${groupsUsed} из ${groupsTotal}`
                : "Не все загруженные файлы удалось использовать"}
            </p>
            <ul className="mt-1 flex flex-col gap-1 text-sm text-muted-foreground">
              {skipped.map((d, i) => (
                <li key={i}>
                  {skipLine(d)}
                </li>
              ))}
              {legacySkipped.map((w, i) => (
                <li key={`l${i}`}>{w}</li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-muted-foreground">
              Выводы справедливы только для данных, которые удалось прочитать.
            </p>
          </div>
        </section>
      )}
      {hasDetails && (
        <details className="rounded-korpus border border-border bg-card px-5 py-3 text-sm shadow-sm">
          <summary className="flex cursor-pointer items-center gap-2 font-medium text-foreground">
            <Info className="h-4 w-4 text-korpus-blue" strokeWidth={2} aria-hidden />
            Что мы поняли в ваших файлах
          </summary>
          <ul className="mt-3 flex flex-col gap-1.5 text-muted-foreground">
            {rep?.answer_files != null && (
              <li>
                Файлов с ответами: {rep.answer_files}, прочитано: {rep.answer_files_used ?? rep.answer_files}
                {groupsTotal > 0 ? `; групп учтено: ${groupsUsed} из ${groupsTotal}` : ""}.
              </li>
            )}
            {rep?.has_reference != null && (
              <li>
                Эталон: {rep.has_reference ? `загружен («${rep.reference_name}»)` : "не загружен"}.
              </li>
            )}
            {limitations.map((l, i) => (
              <li key={`lim${i}`}>{l}</li>
            ))}
            {notes.map((n, i) => (
              <li key={`n${i}`}>{n}</li>
            ))}
            {otherWarnings.map((w, i) => (
              <li key={`w${i}`}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// --- Group switcher pill ----------------------------------------------------------

function GroupPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-4 py-1.5 text-sm font-medium transition-colors",
        active
          ? "border-korpus-blue bg-korpus-blue text-white"
          : "border-border bg-card text-muted-foreground hover:border-korpus-blue/50 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

// --- Metric card ------------------------------------------------------------------

const TONE_BADGE: Record<Metric["tone"], string> = {
  blue: "bg-korpus-blue/10 text-korpus-blue",
  green: "bg-korpus-up/10 text-korpus-up",
  orange: "bg-orange-100 text-orange-600",
  red: "bg-korpus-down/10 text-korpus-down",
};

function MetricCard({ metric }: { metric: Metric }) {
  const Icon = metric.icon;
  return (
    <article className="flex flex-col rounded-korpus border border-border bg-card p-4 shadow-sm">
      {/* min-h = two label lines, so the numbers of neighbouring cards sit on one baseline. */}
      <div className="flex min-h-[2.5rem] items-start gap-2.5">
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-korpus",
            TONE_BADGE[metric.tone],
          )}
        >
          <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </span>
        <span className="mt-1 text-[13px] font-medium leading-snug text-muted-foreground">
          {metric.label}
        </span>
      </div>
      <p className="mt-3 text-[28px] font-bold leading-none text-foreground">{metric.value}</p>
      {metric.delta ? (
        <Delta tone={metric.deltaTone ?? "neutral"} text={metric.delta} className="mt-3" />
      ) : (
        <p className="mt-3 text-xs text-transparent" aria-hidden>
          .
        </p>
      )}
    </article>
  );
}

/** A small delta line: up arrow (green/good), down/up arrow (red/bad), or a dash. */
function Delta({
  tone,
  text,
  className,
}: {
  tone: DeltaTone;
  text: string;
  className?: string;
}) {
  if (tone === "neutral") {
    return (
      <p className={cn("flex items-center gap-1 text-[13px] text-muted-foreground", className)}>
        <Minus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        <span>{text}</span>
      </p>
    );
  }
  // A negative metric (down arrow + red) and an "up but bad" metric (up arrow + red)
  // both read as red; positive metrics read green. We key colour off deltaTone and
  // choose the arrow from the text's leading sign so it matches the mockup exactly.
  const negative = text.trim().startsWith("−") || text.trim().startsWith("-");
  const Arrow = negative ? ArrowDown : ArrowUp;
  const colour = tone === "up" ? "text-korpus-up" : "text-korpus-down";
  return (
    <p className={cn("flex items-center gap-1 text-[13px] font-medium", colour, className)}>
      <Arrow className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
      <span>{text}</span>
    </p>
  );
}

// --- Insight card -----------------------------------------------------------------

const INSIGHT_TONE: Record<Insight["tone"], string> = {
  blue: "text-korpus-blue",
  orange: "text-orange-500",
  green: "text-korpus-up",
  red: "text-korpus-down",
};

function InsightBlock({ insight }: { insight: Insight }) {
  const Icon = insight.icon;
  return (
    <article className="rounded-korpus border border-border bg-card px-6 py-5 shadow-sm">
      <div className="flex items-center gap-2.5">
        <Icon className={cn("h-5 w-5 shrink-0", INSIGHT_TONE[insight.tone])} strokeWidth={2} />
        <h3 className="text-base font-semibold leading-snug text-foreground">{insight.title}</h3>
      </div>
      {/* ~75 characters per line: comfortable to read even on a wide screen. */}
      <div className="mt-3 max-w-[75ch] text-[15px] leading-relaxed text-foreground/90">
        <InsightItems items={insight.items} />
      </div>
    </article>
  );
}

/** Paragraphs and bullet lists of one AI block, in their original order. */
function InsightItems({ items }: { items: AiItem[] }) {
  const out: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = (key: number) => {
    if (!bullets.length) return;
    out.push(
      <ul key={`ul${key}`} className="mb-3 list-disc space-y-2 pl-5 marker:text-muted-foreground/70 last:mb-0">
        {bullets.map((t, i) => (
          <li key={i} className="pl-1">
            {t}
          </li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  items.forEach((it, i) => {
    if (it.kind === "li") {
      bullets.push(it.text);
      return;
    }
    flush(i);
    out.push(
      <p key={`p${i}`} className="mb-3 last:mb-0">
        {it.text}
      </p>,
    );
  });
  flush(items.length);
  return <>{out}</>;
}

// --- Critical questions table -----------------------------------------------------

const RISK_BADGE: Record<RiskLevel, string> = {
  Высокий: "bg-korpus-down/10 text-korpus-down",
  Повышенный: "bg-orange-100 text-orange-600",
  Средний: "bg-amber-100 text-amber-700",
};

function CriticalQuestionsTable({ questions }: { questions: CriticalQuestion[] }) {
  return (
    <section
      aria-label="Критические вопросы"
      className="flex flex-col rounded-korpus border border-border bg-card p-6 shadow-sm"
    >
      <h2 className="text-lg font-semibold text-foreground">Критические вопросы</h2>
      <p className="mt-1 text-[13px] text-muted-foreground">
        Критический — вопрос, на который верно ответили меньше {CRITICAL_PERCENT}% отвечавших. Риск:
        ниже {HIGH_RISK_PERCENT}% — высокий, {HIGH_RISK_PERCENT}–{CRITICAL_PERCENT}% — повышенный.
      </p>

      {questions.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Критических вопросов не обнаружено — доля верных ответов выше порога по всем вопросам.
        </p>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[980px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border text-xs font-medium text-muted-foreground">
                  <th scope="col" className="whitespace-nowrap py-2 pr-3 font-medium">
                    Доля верных
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Вопрос
                  </th>
                  <th scope="col" className="whitespace-nowrap py-2 pr-3 font-medium">
                    Тесты
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Правильный ответ
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Частые ошибки
                  </th>
                  <th scope="col" className="whitespace-nowrap py-2 pr-3 font-medium">
                    Риск
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Рекомендация
                  </th>
                </tr>
              </thead>
              <tbody>
                {questions.map((q, i) => (
                  <tr key={i} className="border-b border-border/60 align-top last:border-0">
                    <td className="py-3 pr-3">
                      <span className="text-base font-bold text-korpus-down">{q.correctRate}%</span>
                    </td>
                    <td className="w-[24%] py-3 pr-3 text-[13px] leading-snug text-foreground">
                      {q.question}
                    </td>
                    <td
                      className="whitespace-nowrap py-3 pr-3 text-[13px] text-muted-foreground"
                      title={q.tests.join("\n")}
                    >
                      {q.tests.length > 1 ? `в ${q.tests.length} тестах` : (q.tests[0] ?? "—")}
                    </td>
                    <td className="w-[16%] break-words py-3 pr-3 text-[13px] leading-snug text-foreground">
                      {q.correctAnswer ?? <span className="text-muted-foreground">{NO_REFERENCE}</span>}
                    </td>
                    <td className="w-[20%] py-3 pr-3">
                      <div className="flex flex-col items-start gap-1.5">
                        {q.errors.map((e, j) => (
                          <span
                            key={j}
                            title={e.full}
                            className="inline-flex max-w-full items-start gap-1.5 rounded-korpus bg-korpus-down/5 px-2 py-1 text-[12px] font-medium leading-snug text-korpus-down"
                          >
                            <span className="min-w-0 break-words">{e.label}</span>
                            <span className="shrink-0 text-korpus-down/70">×{e.count}</span>
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-3 pr-3">
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
                          RISK_BADGE[q.risk],
                        )}
                      >
                        {q.risk}
                      </span>
                    </td>
                    <td className="w-[20%] py-3 text-[13px] leading-snug text-muted-foreground">
                      {q.keySuspect && (
                        <span className="mb-1 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                          Возможна ошибка в эталоне
                        </span>
                      )}
                      <span className="block">{q.recommendation}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-4 self-start text-sm font-semibold text-korpus-blue">
            Всего критических вопросов: {questions.length}
          </p>
        </>
      )}
    </section>
  );
}

// --- Attempts panel ---------------------------------------------------------------

function AttemptsPanel({
  stats,
  statusRows,
  distribution,
  anomalies,
  anomaliesOpen,
  onToggleAnomalies,
  totalListeners,
}: {
  stats: AttemptStat[];
  statusRows: StatusRow[];
  distribution: Distribution;
  anomalies: AttemptAnomaly[];
  anomaliesOpen: boolean;
  onToggleAnomalies: () => void;
  totalListeners: number | null;
}) {
  const manyAnomalies = totalListeners ? anomalies.length / totalListeners > 0.5 : false;
  return (
    <section
      aria-label="Анализ попыток"
      className="flex flex-col rounded-korpus border border-border bg-card p-6 shadow-sm"
    >
      <h2 className="text-lg font-semibold text-foreground">Анализ попыток</h2>

      {/* Stat cards */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {stats.map((s) => (
          <AttemptStatCard
            key={s.id}
            stat={s}
            onClick={s.id === "anomalies" && anomalies.length > 0 ? onToggleAnomalies : undefined}
            expanded={s.id === "anomalies" ? anomaliesOpen : undefined}
          />
        ))}
      </div>
      <p className="mt-3 text-[13px] leading-snug text-muted-foreground">
        Необычным считаем ход попыток, если балл резко вырос (на 50 п.п. и больше) после брошенной
        или почти нулевой попытки, либо слушатель сделал три и более попытки с большим разбросом
        баллов. Это повод посмотреть, не помогали ли слушателю и не запоминал ли он ответы, но не
        доказательство.
        {manyAnomalies &&
          " Таких слушателей здесь больше половины — вероятно, многократные пересдачи для этого курса обычны."}
      </p>

      {anomaliesOpen && anomalies.length > 0 && (
        <div className="mt-4 overflow-x-auto" aria-label="Слушатели с необычным ходом попыток">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">Слушатель</th>
                <th scope="col" className="py-2 pr-3 font-medium">Попыток</th>
                <th scope="col" className="py-2 pr-3 font-medium">Балл, от → до</th>
                <th scope="col" className="py-2 font-medium">Причина</th>
              </tr>
            </thead>
            <tbody>
              {anomalies.map((a, i) => (
                <tr key={i} className="border-b border-border/60 align-top last:border-0">
                  <td className="py-2 pr-3 font-medium text-foreground">{a.student_id ?? "—"}</td>
                  <td className="py-2 pr-3">{a.attempts ?? "—"}</td>
                  <td className="whitespace-nowrap py-2 pr-3">
                    {a.score_min ?? "—"}% → {a.score_max ?? "—"}%
                  </td>
                  <td className="py-2 text-muted-foreground">{a.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Status breakdown + distribution histogram */}
      <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Статус попыток</h3>
          {statusRows.length === 0 ? (
            <p className="mt-3 text-[13px] text-muted-foreground">Нет данных о попытках.</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-3">
              {statusRows.map((row) => (
                <li key={row.label} className="flex items-center gap-3 text-[13px]">
                  <span className="w-[120px] shrink-0 text-muted-foreground">{row.label}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      className={cn(
                        "block h-full rounded-full",
                        row.tone === "blue" ? "bg-korpus-blue" : "bg-orange-500",
                      )}
                      style={{ width: `${row.percent}%` }}
                    />
                  </span>
                  <span className="w-[72px] shrink-0 text-right">
                    <span className="font-semibold text-foreground">{row.percent}%</span>
                    <span className="ml-1 text-muted-foreground">({row.count})</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {distribution.unit === "person"
              ? "Распределение лучших баллов слушателей"
              : "Распределение долей верных ответов по вопросам"}
          </h3>
          {distribution.buckets.length === 0 ? (
            <p className="mt-3 text-[13px] text-muted-foreground">Недостаточно данных для гистограммы.</p>
          ) : (
            <ScoreHistogram distribution={distribution} />
          )}
        </div>
      </div>
    </section>
  );
}

function AttemptStatCard({
  stat,
  onClick,
  expanded,
}: {
  stat: AttemptStat;
  onClick?: () => void;
  expanded?: boolean;
}) {
  const Icon = stat.icon;
  const body = (
    <>
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-korpus",
            stat.tone === "orange"
              ? "bg-orange-100 text-orange-600"
              : "bg-korpus-blue/10 text-korpus-blue",
          )}
        >
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <span className="text-xs font-medium leading-tight text-muted-foreground">{stat.label}</span>
      </div>
      <p className="mt-2 text-2xl font-bold leading-none text-foreground">{stat.value}</p>
      {stat.hint && <p className="mt-1.5 text-xs text-korpus-blue">{stat.hint}</p>}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-expanded={expanded}
        className="flex flex-col rounded-korpus border border-border bg-muted/40 p-3 text-left transition-colors hover:border-korpus-blue/50"
      >
        {body}
      </button>
    );
  }
  return <article className="flex flex-col rounded-korpus border border-border bg-muted/40 p-3">{body}</article>;
}

/** Score-distribution histogram via Recharts: equal ten-point intervals, bar height = number of
 *  people (or questions on older runs), hover tooltip with the share. */
function ScoreHistogram({ distribution }: { distribution: Distribution }) {
  // Resolve brand-blue from the CSS token so the chart stays on-palette.
  const blue = "hsl(222 80% 48%)";
  const lightBlue = "hsl(222 80% 70%)";
  const noun = distribution.unit === "person" ? "чел." : "вопр.";
  return (
    <div>
      <div className="mt-2 h-[170px] w-full" aria-label="Распределение баллов — гистограмма">
        <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={170}>
          <BarChart data={distribution.buckets} margin={{ top: 18, right: 4, bottom: 0, left: 4 }}>
            <XAxis
              dataKey="range"
              tickLine={false}
              axisLine={false}
              interval={0}
              tick={{ fontSize: 12, fill: "hsl(217 12% 35%)" }}
              height={22}
            />
            <Tooltip
              cursor={{ fill: "hsl(217 12% 90% / 0.5)" }}
              formatter={(value: number, _n: string, item: { payload?: ScoreBucket }) => [
                `${value} ${noun} (${item.payload?.percent ?? 0}%)`,
                "Количество",
              ]}
              labelFormatter={(label: string) => `Баллы ${label}%`}
            />
            <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={32} isAnimationActive={false}>
              <LabelList
                dataKey="count"
                position="top"
                formatter={(v: number) => (v > 0 ? String(v) : "")}
                style={{ fontSize: 12, fill: "hsl(217 12% 30%)", fontWeight: 600 }}
              />
              {distribution.buckets.map((b, i) => (
                <Cell key={i} fill={b.peak ? blue : lightBlue} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        По горизонтали — баллы в процентах (интервалы по 10), над столбцом — {noun === "чел." ? "число слушателей" : "число вопросов"}.
        Наведите на столбец, чтобы увидеть долю.
      </p>
    </div>
  );
}

// --- Collapsible text report ------------------------------------------------------

function TextReport({
  open,
  onToggle,
  body,
}: {
  open: boolean;
  onToggle: () => void;
  body: string;
}) {
  const hasBody = body.trim().length > 0;
  return (
    <section className="mt-6 rounded-korpus border border-border bg-card shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start gap-4 p-6 text-left"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-korpus bg-korpus-blue/10 text-korpus-blue">
          <FileText className="h-5 w-5" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground">Текстовый отчёт</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Краткая сводка по данным: основные цифры, самые трудные вопросы с верным ответом и
            типичными ошибками, замечания по данным. Его можно взять в отчёт как есть.
          </p>
        </div>
        <ChevronDown
          aria-hidden
          className={cn(
            "mt-1 h-5 w-5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          strokeWidth={2}
        />
      </button>

      {open && (
        <div className="border-t border-border px-6 py-5 text-sm leading-relaxed text-muted-foreground">
          {hasBody ? (
            body.split(/\n\n+/).map((para, i) => (
              <p key={i} className={cn("whitespace-pre-line", i > 0 && "mt-3")}>
                {para}
              </p>
            ))
          ) : (
            <p>Для этого анализа нет данных для текстового отчёта.</p>
          )}
        </div>
      )}
    </section>
  );
}
