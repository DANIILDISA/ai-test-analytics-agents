// web/frontend/src/screens/NewAnalysis.tsx
// "Новый анализ": the two upload cards + «Запустить анализ». The analysis parameters (model
// group, deep AI analysis, what to analyse, max model calls) live in Настройки and are read here
// as the defaults of every run (GET /settings → analysis_defaults); one muted line under the
// button says what the run will use and links to the settings. POSTs /analyze as multipart,
// shows an in-progress/error state and navigates to /results?run=<id> on success.
import * as React from "react";
import { useRef, useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Sparkles,
  Target,
  AlertTriangle,
  Clock,
  Lightbulb,
  Loader2,
  MessageCircle,
  UploadCloud,
  FileSpreadsheet,
  FileText,
  Play,
  RotateCcw,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  analyzeRun,
  getAnalysisDefaults,
  FALLBACK_ANALYSIS_DEFAULTS,
  type AnalysisDefaults,
  type AnalyzeRequest,
} from "@/api/client";
import { analysisSummary, modeFromBlocks, ASPECT_KEYS } from "@/lib/analysisParams";
import { cn } from "@/lib/utils";

// --- Static copy mirrored from the mockup (kept in one place for the panel below). ---

interface AiCapability {
  icon: LucideIcon;
  title: string;
  body: string;
}

const AI_CAPABILITIES: AiCapability[] = [
  {
    icon: Target,
    title: "Вопросы с низкой долей верных",
    body: "Выявляет вопросы, на которые чаще всего отвечают неправильно.",
  },
  {
    icon: AlertTriangle,
    title: "Частые ошибки",
    body: "Находит типичные ошибки и заблуждения пользователей.",
  },
  {
    icon: Clock,
    title: "Брошенные попытки",
    body: "Определяет, где пользователи прерывают тестирование и почему.",
  },
  {
    icon: Lightbulb,
    title: "Рекомендации",
    body: "Формирует рекомендации по улучшению вопросов и курса.",
  },
];

/** Formats the analysis reads (the server also accepts .json, which is not advertised). */
const SUPPORTED_EXT = [".xlsx", ".csv", ".json"];

function isSupportedFile(f: File): boolean {
  const name = f.name.toLowerCase();
  return SUPPORTED_EXT.some((ext) => name.endsWith(ext));
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

/** «…группа 2.xlsx» → «Группа 2» (what we will call the group), or null. */
function groupHint(name: string): string | null {
  const m = name.match(/(?:групп[аеноуы]*|group|gr)\s*[_\-]?\s*(\d+)/i);
  return m ? `Группа ${m[1]}` : null;
}

export function NewAnalysis() {
  const navigate = useNavigate();

  // Upload state — several answer files = groups (one run with a per-group breakdown).
  const [answersFiles, setAnswersFiles] = useState<File[]>([]);
  const [referenceFile, setReferenceFile] = useState<File | null>(null);

  // Параметры анализа — the saved defaults from Настройки (built-in ones until they arrive).
  const [defaults, setDefaults] = useState<AnalysisDefaults>(FALLBACK_ANALYSIS_DEFAULTS);
  useEffect(() => {
    let alive = true;
    void getAnalysisDefaults().then((d) => {
      if (alive) setDefaults(d);
    });
    return () => {
      alive = false;
    };
  }, []);
  const deep = defaults.deep;

  // Submission state — drives the in-progress button + the error banner.
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);

  // Seconds counter for the progress panel while an analysis is running.
  useEffect(() => {
    if (!running) return;
    setElapsed(0);
    const t0 = Date.now();
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  // Bring the error / progress panel into view: on a short window the button row is below the fold.
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [error]);
  useEffect(() => {
    if (running) progressRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [running]);

  const unsupported = [...answersFiles, ...(referenceFile ? [referenceFile] : [])].filter((f) => !isSupportedFile(f));
  const usableAnswers = answersFiles.filter(isSupportedFile);
  const usableReference = referenceFile && isSupportedFile(referenceFile) ? referenceFile : null;

  const reset = () => {
    setAnswersFiles([]);
    setReferenceFile(null);
    setError(null);
  };

  const cancelRun = () => {
    abortRef.current?.abort();
  };

  const runAnalysis = async () => {
    if (!usableAnswers.length || running) return;
    setRunning(true);
    setError(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Map the saved defaults onto the /analyze contract. «Глубокий анализ с ИИ» gates BOTH the
    // per-answer model budget and the AI commentary; the chosen aspects pick the insight blocks
    // (all of them when none are selected, so the switch alone always yields insights).
    const blocks = defaults.aspects.length ? defaults.aspects : ASPECT_KEYS;
    const req: AnalyzeRequest = {
      answers: usableAnswers,
      reference: usableReference,
      modelGroup: defaults.model_group,
      // Without the AI the aspects are irrelevant: the free analysis runs everything.
      mode: deep ? modeFromBlocks(blocks) : "all",
      maxLlmCalls: deep ? defaults.max_llm_calls : 0,
      useInsights: deep,
      insightBlocks: blocks,
      signal: ctrl.signal,
    };

    try {
      const result = await analyzeRun(req);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (!result.run_id) {
        setError("Анализ завершился без идентификатора результата.");
        return;
      }
      // Hand the run to the Результаты tab via a URL query param (?run=<id>) — the
      // shared contract agreed with the Results-screen wiring.
      navigate(`/results?run=${encodeURIComponent(result.run_id)}`);
    } catch (e) {
      if (ctrl.signal.aborted) {
        setError(
          "Ожидание отменено. Если расчёт уже успел завершиться на сервере, анализ появится в «Истории».",
        );
      } else {
        setError(e instanceof Error ? e.message : "Не удалось выполнить анализ.");
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-background font-korpus">
      <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-8 sm:py-8">
        {/* Header */}
        <header>
          <h1 className="text-[28px] font-bold leading-tight tracking-tight text-foreground sm:text-[40px]">
            Анализ результатов тестов
          </h1>
          <p className="mt-2 text-base text-muted-foreground">
            Загрузите ответы пользователей и запустите анализ
          </p>
        </header>

        {/* Two-column body: left = uploads + params, right = "Что анализирует ИИ". */}
        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* LEFT COLUMN */}
          <div className="flex flex-col gap-6">
            {/* Upload cards */}
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <UploadCard
                title="Ответы пользователей"
                subtitle="Обязательно · .xlsx или .csv, несколько групп"
                emphasized
                multiple
                files={answersFiles}
                onFiles={setAnswersFiles}
              />
              <UploadCard
                title="Эталонные ответы"
                subtitle="Рекомендуется · один файл на все группы"
                note="Можно запустить и без эталона: тогда ответы со свободным вводом (текст, числа) не сверяются с правильными ответами, остальное считается как обычно."
                files={referenceFile ? [referenceFile] : []}
                onFiles={(f) => setReferenceFile(f[0] ?? null)}
              />
            </div>
          </div>

          {/* RIGHT SIDEBAR — Что анализирует ИИ */}
          <aside
            aria-label="Что анализирует ИИ"
            className="rounded-korpus border border-border bg-card p-6 shadow-sm"
          >
            <div className="flex items-center gap-2.5">
              <Sparkles className="h-5 w-5 text-korpus-blue" strokeWidth={2} />
              <h2 className="text-base font-semibold text-foreground">Что анализирует ИИ</h2>
            </div>

            <ul className="mt-5 flex flex-col gap-5">
              {AI_CAPABILITIES.map((c) => {
                const Icon = c.icon;
                return (
                  <li key={c.title} className="flex items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-korpus-blue/10 text-korpus-blue">
                      <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold leading-snug text-foreground">{c.title}</p>
                      <p className="mt-1 text-[13px] leading-snug text-muted-foreground">{c.body}</p>
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* CTA — open chat with the agent */}
            <div className="mt-6 flex items-start gap-3 rounded-korpus bg-muted p-4">
              <MessageCircle className="mt-0.5 h-5 w-5 shrink-0 text-korpus-blue" strokeWidth={1.75} />
              <div className="min-w-0">
                <p className="text-[13px] leading-snug text-muted-foreground">
                  Есть вопросы по прошлым анализам?
                </p>
                <a
                  href="/chat"
                  className="mt-0.5 inline-block text-sm font-semibold text-korpus-blue hover:underline"
                >
                  Откройте чат с агентом
                </a>
              </div>
            </div>
          </aside>
        </div>

        {/* Unsupported files are named BEFORE the run, not after it. */}
        {unsupported.length > 0 && (
          <div
            role="status"
            className="mt-8 flex items-start gap-3 rounded-korpus border border-amber-300 bg-amber-50 p-4"
          >
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" strokeWidth={2} />
            <p className="min-w-0 text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]">
              Не будут учтены (неподдерживаемый формат): {unsupported.map((f) => `«${f.name}»`).join(", ")}.
              Нужны файлы .xlsx или .csv, выгруженные из СДО.
            </p>
          </div>
        )}

        {/* Error banner — Russian message from the backend (config/key/analysis error). */}
        {error && (
          <div
            ref={errorRef}
            role="alert"
            className="mt-8 flex items-start gap-3 rounded-korpus border border-korpus-down/30 bg-korpus-down/5 p-4"
          >
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-korpus-down" strokeWidth={2} />
            <p className="min-w-0 text-sm leading-relaxed text-korpus-down [overflow-wrap:anywhere]">{error}</p>
          </div>
        )}

        {/* Progress — the server answers once at the end, so we show honest elapsed time. */}
        {running && (
          <div
            ref={progressRef}
            role="status"
            aria-label="Ход анализа"
            className="mt-8 rounded-korpus border border-korpus-blue/30 bg-korpus-blue/5 p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-korpus-blue" strokeWidth={2} />
                Идёт анализ: чтение файлов, расчёт{deep ? ", запросы к ИИ" : ""} · прошло {elapsed} с
              </p>
              <Button type="button" variant="outline" size="sm" onClick={cancelRun}>
                Отмена
              </Button>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-border">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-korpus-blue" />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {deep
                ? "С ИИ анализ обычно занимает 30–60 секунд (больше файлов — дольше)."
                : "Без ИИ анализ обычно занимает несколько секунд."}{" "}
              Не закрывайте страницу.
            </p>
          </div>
        )}

        {/* Action buttons */}
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <Button
            type="button"
            className="h-12 px-6 text-base"
            onClick={runAnalysis}
            disabled={!usableAnswers.length || running}
            title={!usableAnswers.length ? "Загрузите хотя бы один файл ответов пользователей (.xlsx или .csv)" : undefined}
          >
            {running ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2} />
                Идёт анализ…
              </>
            ) : (
              <>
                <Play className="h-5 w-5 fill-current" strokeWidth={0} />
                Запустить анализ
              </>
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-12 px-6 text-base text-korpus-blue"
            onClick={reset}
            disabled={running}
          >
            <RotateCcw className="h-5 w-5" strokeWidth={1.75} />
            Сбросить
          </Button>
        </div>
        <p className="mt-3 text-sm text-muted-foreground" data-testid="analysis-summary">
          {analysisSummary(defaults)} ·{" "}
          <Link to="/settings" className="font-medium text-korpus-blue hover:underline">
            изменить в настройках
          </Link>
        </p>
      </div>
    </div>
  );
}

// --- Upload card -----------------------------------------------------------------

interface UploadCardProps {
  title: string;
  subtitle: string;
  /** The required answers card gets the solid-blue icon badge + blue-tinted border. */
  emphasized?: boolean;
  /** Allow several files (answer groups). Reference stays single. */
  multiple?: boolean;
  /** Extra explanation under the header (e.g. when the file may be omitted). */
  note?: string;
  files: File[];
  onFiles: (files: File[]) => void;
}

function UploadCard({ title, subtitle, emphasized, multiple = false, note, files, onFiles }: UploadCardProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const pick = () => inputRef.current?.click();

  // Single → replace; multiple → append, de-duplicating by name+size.
  const add = (picked: File[]) => {
    if (!picked.length) return;
    if (!multiple) {
      onFiles([picked[0]]);
      return;
    }
    const key = (f: File) => `${f.name}:${f.size}`;
    const seen = new Set(files.map(key));
    onFiles([...files, ...picked.filter((f) => !seen.has(key(f)))]);
  };

  const removeAt = (i: number) => onFiles(files.filter((_, idx) => idx !== i));

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    add(Array.from(e.dataTransfer.files ?? []));
  };

  return (
    <section
      className={cn(
        "flex h-full min-w-0 flex-col rounded-korpus border bg-card p-4 shadow-sm sm:p-6",
        emphasized ? "border-korpus-blue/40" : "border-border",
      )}
    >
      {/* Header: file-type badge + titles */}
      {/* Two-line subtitle room below `xl` (cards are narrow there) keeps both drop zones level. */}
      <div className="flex min-h-[56px] items-center gap-4 sm:min-h-[84px] xl:min-h-[56px]">
        <span
          className={cn(
            "flex h-14 w-14 shrink-0 items-center justify-center rounded-korpus",
            emphasized ? "bg-korpus-blue text-white" : "bg-korpus-blue/10 text-korpus-blue",
          )}
        >
          <FileSpreadsheet className="h-7 w-7" strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <h3 className="text-lg font-semibold leading-tight text-foreground">{title}</h3>
          <p className="mt-0.5 text-sm font-medium text-korpus-blue xl:whitespace-nowrap">{subtitle}</p>
        </div>
      </div>

      {/* Drop zone */}
      <button
        type="button"
        onClick={pick}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "mt-5 flex h-[208px] shrink-0 flex-col items-center justify-center rounded-korpus border-2 border-dashed px-6 py-6 text-center transition-colors",
          dragging
            ? "border-korpus-blue bg-korpus-blue/5"
            : "border-border hover:border-korpus-blue/50 hover:bg-muted/40",
        )}
      >
        <UploadCloud className="h-11 w-11 text-korpus-blue" strokeWidth={1.5} />
        <p className="mt-3 text-sm font-medium text-foreground">
          {multiple ? "Перетащите файлы сюда или нажмите для выбора" : "Перетащите файл сюда или нажмите для выбора"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Формат: .xlsx или .csv, до 50 МБ{multiple ? " · можно несколько" : ""}
        </p>
      </button>

      {/* Selected files — each removable; for several files they are the groups. */}
      {files.length > 0 && (
        <ul className="mt-3 flex max-h-72 flex-col gap-1.5 overflow-y-auto">
          {files.map((f, i) => {
            const ok = isSupportedFile(f);
            const grp = multiple ? groupHint(f.name) : null;
            return (
            <li
              key={`${f.name}:${f.size}:${i}`}
              className={cn(
                "flex items-center gap-2 rounded-korpus border px-3 py-1.5",
                ok ? "border-border bg-muted/40" : "border-korpus-down/40 bg-korpus-down/5",
              )}
            >
              <FileSpreadsheet
                className={cn("h-4 w-4 shrink-0", ok ? "text-korpus-blue" : "text-korpus-down")}
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground" title={f.name}>
                {f.name}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {ok ? [grp, fmtSize(f.size)].filter(Boolean).join(" · ") : "не поддерживается"}
              </span>
              <button
                type="button"
                onClick={() => removeAt(i)}
                aria-label={`Убрать «${f.name}»`}
                className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-border/60 hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" strokeWidth={2.5} />
              </button>
            </li>
            );
          })}
        </ul>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
        className="hidden"
        aria-label={`${title} — выбрать файл`}
        // Reset value before the dialog opens so re-picking the SAME file still fires
        // onChange (the classic file-input gotcha — bug #6).
        onClick={(e) => {
          (e.currentTarget as HTMLInputElement).value = "";
        }}
        onChange={(e) => add(Array.from(e.target.files ?? []))}
      />

      {/* Выбрать / Добавить файл(ы) + hint, pinned to the bottom so both cards line up. */}
      <div className="mt-auto flex flex-col gap-3 pt-5">
        <Button
          type="button"
          variant="outline"
          onClick={pick}
          className="self-start text-korpus-blue"
        >
          <FileText className="h-[18px] w-[18px]" strokeWidth={1.75} />
          {multiple ? "Добавить файл(ы)" : files.length ? "Заменить файл" : "Выбрать файл"}
        </Button>
        {/* Fixed-height slot so both cards keep identical bottoms. */}
        <div className="min-h-[3.5rem]">
          {note && <p className="text-[13px] leading-snug text-muted-foreground">{note}</p>}
        </div>
      </div>
    </section>
  );
}
