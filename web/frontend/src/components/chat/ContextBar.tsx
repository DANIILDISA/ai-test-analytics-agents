// web/frontend/src/components/chat/ContextBar.tsx
import { useState } from "react";
import { Users, BookOpen, LineChart, FileQuestion, X, ChevronDown, ChevronUp, Layers } from "lucide-react";
import { contextRunIds, type ThreadContext } from "@/types/chat";
import type { RunMeta } from "@/api/client";
import { courseLabel, plural } from "@/lib/runs";

/** From this many attached analyses the list collapses into one «N анализов прикреплено» line. */
export const COLLAPSE_FROM = 4;

// The bar shows REAL metrics of every attached run; anything unknown is dashed, and when
// nothing is attached it says so plainly. No fabricated placeholder numbers (#5/#11).
//
// Layout contract: ONE compact row per analysis (icon · full name with ellipsis + tooltip ·
// course / % / users as muted meta · icon-only ✕). Names truncate, meta never wraps, the ✕ is
// its own flex item so it can never overlap text. With many analyses the list collapses to a
// single summary line and, once expanded, scrolls inside a bounded height — the header of the
// chat never pushes the conversation off screen.
export function ContextBar({
  context,
  runsById,
  onDetach,
  anyMissing = false,
}: {
  context: ThreadContext | null;
  /** Resolved run metadata keyed by run id; missing entries render with dashes. */
  runsById: Record<string, RunMeta>;
  /** Detach (открепить) a single bound analysis from the chat by its run id. */
  onDetach: (runId: string) => void;
  /** The server says at least one bound analysis no longer exists. */
  anyMissing?: boolean;
}) {
  const ids = contextRunIds(context);
  const [expanded, setExpanded] = useState(false);

  if (ids.length === 0) {
    return (
      <div className="flex shrink-0 items-center gap-3 rounded-korpus border border-dashed border-border bg-card px-4 py-3 font-korpus shadow-sm sm:px-5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <FileQuestion className="h-[18px] w-[18px]" strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">Анализ не выбран</div>
          <div className="text-xs text-muted-foreground">
            Прикрепите анализ ниже — и агент будет отвечать по его данным.
          </div>
        </div>
      </div>
    );
  }

  const collapsible = ids.length >= COLLAPSE_FROM;
  // A deleted analysis must stay visible (amber row) — never hide it behind the collapsed summary.
  const showList = !collapsible || expanded || anyMissing;
  // Unique, human course labels of everything attached — the one-line summary when collapsed.
  const courses = Array.from(
    new Set(ids.map((id) => courseLabel(runsById[id] ?? {}) ?? "").filter(Boolean)),
  );

  return (
    <div
      role="group"
      aria-label="Прикреплённые анализы"
      className="flex shrink-0 flex-col overflow-hidden rounded-korpus border border-border bg-card font-korpus shadow-sm"
    >
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/60"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-korpus-blue/10 text-korpus-blue">
            <Layers className="h-4 w-4" strokeWidth={2} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-bold text-foreground">
              {ids.length} {plural(ids.length, "анализ", "анализа", "анализов")} прикреплено
            </span>
            {courses.length > 0 && (
              <span className="block truncate text-xs text-muted-foreground" title={courses.join(", ")}>
                {courses.join(", ")}
              </span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-korpus-blue">
            <span className="hidden sm:inline">{expanded ? "Свернуть" : "Показать список"}</span>
            {expanded ? (
              <ChevronUp className="h-4 w-4" strokeWidth={2} />
            ) : (
              <ChevronDown className="h-4 w-4" strokeWidth={2} />
            )}
          </span>
        </button>
      )}

      {showList && (
        <ul
          className={`flex flex-col divide-y divide-border ${
            collapsible ? "max-h-[13.5rem] overflow-y-auto border-t border-border" : ""
          }`}
        >
          {ids.map((id) => {
            const run = runsById[id];
            const gone = anyMissing && !run;
            const name = run?.name?.trim() || (gone ? "Анализ удалён" : courseLabel(run ?? {}) || id);
            const course = courseLabel(run ?? {}) ?? "—";
            const avg = run?.summary?.avg_score;
            const users = run?.summary?.total_users;
            return (
              <li
                key={id}
                data-testid="context-run"
                className={`flex min-w-0 items-center gap-3 px-3 py-2 ${gone ? "bg-amber-50" : ""}`}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-korpus-blue/10 text-korpus-blue">
                  <Users className="h-4 w-4" strokeWidth={2} />
                </span>
                {/* Name on top, meta under it on phones; side by side from `sm` up. */}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-4">
                  <div
                    className="min-w-0 flex-1 truncate text-sm font-bold text-foreground"
                    title={name}
                  >
                    {name}
                  </div>
                  <div className="flex shrink-0 items-center gap-3 whitespace-nowrap text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1" title="Курс">
                      <BookOpen className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                      {course}
                    </span>
                    <span className="inline-flex items-center gap-1" title="Средний балл">
                      <LineChart className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                      {avg == null ? "—" : `${Math.round(avg)}%`}
                    </span>
                    <span className="inline-flex items-center gap-1" title="Участников">
                      <Users className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                      {users == null ? "—" : String(users)}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onDetach(id)}
                  aria-label={`Открепить анализ ${name}`}
                  title="Открепить анализ"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-korpus-blue/40"
                >
                  <X className="h-4 w-4" strokeWidth={2.5} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
