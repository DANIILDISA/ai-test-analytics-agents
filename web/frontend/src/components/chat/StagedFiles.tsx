// web/frontend/src/components/chat/StagedFiles.tsx
import { useState } from "react";
import { Paperclip, X } from "lucide-react";
import type { ChatUpload } from "@/api/client";
import { plural } from "@/lib/runs";

/** Up to this many chips are shown as-is; more collapse to the first few + «ещё N». */
export const FILES_COLLAPSE_FROM = 5;
const COLLAPSED_VISIBLE = 3;

/** Staged uploads pinned to the chat — chips just above the composer, each with a
 *  массив/эталон badge and its own ✕. A chip never outgrows the row (filename truncates,
 *  tooltip shows it whole); with many files the list collapses and, expanded, scrolls inside
 *  a bounded height so the composer is never pushed off screen. */
export function StagedFiles({
  files,
  onRemove,
}: {
  files: ChatUpload[];
  onRemove: (stored: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) return null;

  const collapsible = files.length >= FILES_COLLAPSE_FROM;
  const visible = collapsible && !expanded ? files.slice(0, COLLAPSED_VISIBLE) : files;
  const hidden = files.length - visible.length;

  return (
    <div
      role="group"
      aria-label="Прикреплённые файлы"
      className={`flex shrink-0 flex-wrap items-center gap-2 ${
        collapsible && expanded ? "max-h-[6.75rem] overflow-y-auto pr-1" : ""
      }`}
    >
      {visible.map((u) => (
        <span
          key={u.stored}
          data-testid="staged-file"
          className="inline-flex h-8 min-w-0 max-w-full items-center gap-2 rounded-korpus border border-border bg-card pl-2.5 pr-1.5 text-xs text-foreground"
        >
          <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
          <span className="min-w-0 max-w-[12rem] truncate sm:max-w-[16rem]" title={u.filename}>
            {u.filename}
          </span>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
              u.kind === "etalon" ? "bg-korpus-blue/10 text-korpus-blue" : "bg-muted text-muted-foreground"
            }`}
          >
            {u.kind === "etalon" ? "эталон" : "массив"}
          </span>
          <button
            type="button"
            onClick={() => onRemove(u.stored)}
            aria-label={`Убрать файл ${u.filename}`}
            title="Убрать файл из чата"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
        </span>
      ))}
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="h-8 shrink-0 rounded-korpus px-2.5 text-xs font-medium text-korpus-blue transition-colors hover:bg-korpus-blue/10"
        >
          {expanded
            ? "Свернуть"
            : `ещё ${hidden} ${plural(hidden, "файл", "файла", "файлов")}`}
        </button>
      )}
    </div>
  );
}
