// web/frontend/src/components/chat/ThreadSidebar.tsx
import { useState } from "react";
import {
  Plus,
  FolderClosed,
  Scale,
  BookOpen,
  AlertTriangle,
  Pencil,
  Trash2,
  Check,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ThreadMeta, ThreadCategory } from "@/types/chat";

const FILTERS: Array<"Все" | ThreadCategory> = ["Все", "Анализ", "Сравнение", "Курс"];

const CATEGORY_ICON: Record<ThreadCategory, LucideIcon> = {
  Анализ: FolderClosed,
  Сравнение: Scale,
  Курс: BookOpen,
};

/** Pick an icon: comparison/course threads get their glyph; warnings fall back to alert. */
function iconFor(t: ThreadMeta): LucideIcon {
  if (/ошибк|критич/i.test(t.title)) return AlertTriangle;
  return CATEGORY_ICON[t.category] ?? FolderClosed;
}

/** Short relative timestamp shown right-aligned on each row. */
function stamp(meta: ThreadMeta): string {
  const raw = meta.updated_at ?? meta.created_at;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return "";
  const now = Date.now();
  const days = Math.floor((now - d.getTime()) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "Вчера";
  return `${days} дн. назад`;
}

export interface ThreadSidebarProps {
  threads: ThreadMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  /** How many unused «Новый чат» entries exist; > 0 shows a one-click cleanup. */
  emptyCount?: number;
  onCleanupEmpty?: () => void;
}

export function ThreadSidebar({
  threads,
  activeId,
  onSelect,
  onNew,
  onRename,
  onDelete,
  emptyCount = 0,
  onCleanupEmpty,
}: ThreadSidebarProps) {
  const [filter, setFilter] = useState<"Все" | ThreadCategory>("Все");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Inline delete confirmation — kept fully separate from the rename state machine above.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const visible = filter === "Все" ? threads : threads.filter((t) => t.category === filter);

  const startRename = (t: ThreadMeta) => {
    setRenamingId(t.id);
    setDraft(t.title);
  };
  const commitRename = () => {
    if (renamingId) {
      const title = draft.trim();
      if (title) onRename(renamingId, title);
    }
    setRenamingId(null);
  };
  const confirmDelete = () => {
    if (confirmingId) onDelete(confirmingId);
    setConfirmingId(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-korpus border border-border bg-card font-korpus shadow-sm">
      <div className="px-4 pt-4">
        <h2 className="text-lg font-bold text-foreground">Диалоги</h2>
      </div>

      <div className="flex flex-wrap gap-2 px-4 pt-3">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
              filter === f
                ? "bg-korpus-blue text-white"
                : "bg-muted text-muted-foreground hover:bg-border/60",
            )}
          >
            {f}
          </button>
        ))}
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-2 py-3">
        {visible.map((t) => {
          const Icon = iconFor(t);
          const isActive = activeId === t.id;
          const isRenaming = renamingId === t.id;
          const isConfirmingDelete = confirmingId === t.id;
          return (
            <div
              key={t.id}
              onClick={() => !isRenaming && onSelect(t.id)}
              className={cn(
                "group/row relative flex cursor-pointer items-start gap-3 rounded-korpus px-3 py-2.5 text-left transition-colors",
                isActive ? "bg-korpus-blue/[0.07]" : "hover:bg-muted",
              )}
            >
              {isActive && (
                <span
                  aria-hidden
                  className="absolute inset-y-1.5 left-0 w-1 rounded-full bg-korpus-blue"
                />
              )}
              <span
                className={cn(
                  "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-korpus",
                  isActive ? "text-korpus-blue" : "text-muted-foreground",
                )}
              >
                <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-start justify-between gap-2">
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      onBlur={commitRename}
                      className="min-w-0 flex-1 rounded border border-korpus-blue/40 bg-background px-1.5 py-0.5 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-korpus-blue"
                    />
                  ) : (
                    <span
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startRename(t);
                      }}
                      title="Двойной клик — переименовать"
                      className="truncate text-sm font-semibold text-foreground"
                    >
                      {t.title}
                    </span>
                  )}
                  {!isRenaming && !isConfirmingDelete && (
                    <span className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        aria-label="Переименовать чат"
                        onClick={(e) => {
                          e.stopPropagation();
                          startRename(t);
                        }}
                        className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-border/60 hover:text-foreground group-hover/row:opacity-100"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label="Удалить чат"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmingId(t.id);
                        }}
                        className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-500 group-hover/row:opacity-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                      <span className="text-[11px] text-muted-foreground">{stamp(t)}</span>
                    </span>
                  )}
                  {!isRenaming && isConfirmingDelete && (
                    <span className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        aria-label="Подтвердить удаление"
                        onClick={(e) => {
                          e.stopPropagation();
                          confirmDelete();
                        }}
                        className="rounded p-0.5 text-red-500 hover:bg-red-500/10"
                      >
                        <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                      </button>
                      <button
                        type="button"
                        aria-label="Отменить удаление"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmingId(null);
                        }}
                        className="rounded p-0.5 text-muted-foreground hover:bg-border/60"
                      >
                        <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                      </button>
                    </span>
                  )}
                  {isRenaming && (
                    <span className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        aria-label="Сохранить название"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation();
                          commitRename();
                        }}
                        className="rounded p-0.5 text-korpus-blue hover:bg-korpus-blue/10"
                      >
                        <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                      </button>
                      <button
                        type="button"
                        aria-label="Отменить"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenamingId(null);
                        }}
                        className="rounded p-0.5 text-muted-foreground hover:bg-border/60"
                      >
                        <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                      </button>
                    </span>
                  )}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {t.category}
                  {t.run_missing && <span className="ml-1.5 font-medium text-amber-700">· анализ удалён</span>}
                </span>
              </span>
            </div>
          );
        })}
        {visible.length === 0 && (
          <p className="px-3 py-4 text-xs leading-relaxed text-muted-foreground">
            {threads.length === 0
              ? "Диалогов пока нет — создайте новый чат кнопкой ниже."
              : "Нет чатов в этой категории."}
          </p>
        )}
      </nav>

      <div className="border-t border-border px-4 pb-4 pt-3">
        {emptyCount > 0 && onCleanupEmpty && (
          <button
            type="button"
            onClick={onCleanupEmpty}
            className="mb-2 w-full text-center text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
          >
            Убрать пустые чаты ({emptyCount})
          </button>
        )}
        <button
          type="button"
          onClick={onNew}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-korpus bg-korpus-blue text-sm font-semibold text-white transition-colors hover:bg-korpus-blue-hover"
        >
          <Plus className="h-[18px] w-[18px]" /> Новый чат
        </button>
      </div>
    </div>
  );
}
