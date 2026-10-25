// web/frontend/src/components/chat/Composer.tsx
import { useRef, useState } from "react";
import { Paperclip, BarChart3, Trash2, Send, Upload } from "lucide-react";
import { EffortSelector } from "@/components/chat/EffortSelector";
import type { Effort } from "@/types/chat";

export interface ComposerProps {
  effort: Effort;
  onEffortChange: (e: Effort) => void;
  onSend: (message: string) => void;
  onAttachRun: () => void;
  onUseCurrent: () => void;
  onClear?: () => void;
  onUploadFiles?: (files: File[]) => void;
  disabled: boolean;
  /** When set, sending is blocked and this text explains why (e.g. no analysis attached). */
  blockReason?: string | null;
}

export function Composer({
  effort,
  onEffortChange,
  onSend,
  onAttachRun,
  onUseCurrent,
  onClear,
  onUploadFiles,
  disabled,
  blockReason,
}: ComposerProps) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || blockReason) return;
    onSend(trimmed);
    setText("");
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) onUploadFiles?.(files);
    e.target.value = "";
  };

  return (
    <div className="flex shrink-0 flex-col gap-3 font-korpus">
      {/* Hidden file picker driven by the «Загрузить файлы» action. */}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".xlsx,.csv"
        onChange={handleFileChange}
        className="hidden"
      />

      {blockReason && (
        <p
          role="status"
          className="rounded-korpus border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-snug text-foreground"
        >
          {blockReason}
        </p>
      )}

      {/* Input + circular brand-blue send button. */}
      <div className="flex items-center gap-3">
        <input
          placeholder="Напишите вопрос агенту…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={disabled}
          className="h-12 w-full rounded-korpus border border-korpus-blue/30 bg-card px-4 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-korpus-blue focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-korpus-blue/30 disabled:opacity-50"
        />
        <button
          type="button"
          aria-label="Отправить"
          onClick={send}
          disabled={disabled || Boolean(blockReason)}
          title={blockReason ?? undefined}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-korpus bg-korpus-blue text-white transition-colors hover:bg-korpus-blue-hover disabled:pointer-events-none disabled:opacity-50"
        >
          <Send className="h-5 w-5" strokeWidth={2} />
        </button>
      </div>

      {/* Outlined action row + subtle effort selector. */}
      <div className="flex flex-wrap items-center gap-2.5">
        <ActionButton
          icon={Paperclip}
          label="Прикрепить анализ"
          hint="Выбрать из сохранённых анализов тот, по которому будет отвечать агент"
          onClick={onAttachRun}
        />
        <ActionButton
          icon={Upload}
          label="Загрузить файлы"
          hint="Загрузить выгрузки из СДО (.xlsx), чтобы агент запустил по ним новый анализ"
          onClick={() => inputRef.current?.click()}
        />
        <ActionButton
          icon={BarChart3}
          label="Использовать текущий результат"
          hint="Привязать к чату последний выполненный анализ"
          onClick={onUseCurrent}
        />
        <ActionButton
          icon={Trash2}
          label="Очистить чат"
          hint="Стереть сообщения этого чата (привязанный анализ останется)"
          onClick={onClear}
        />
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Глубина</span>
          <EffortSelector value={effort} onChange={onEffortChange} />
        </div>
      </div>
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  hint,
  onClick,
}: {
  icon: typeof Paperclip;
  label: string;
  hint?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={hint}
      onClick={onClick}
      className="flex h-9 items-center gap-2 rounded-korpus border border-border bg-card px-3.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
    >
      <Icon className="h-4 w-4 text-muted-foreground" strokeWidth={2} />
      {label}
    </button>
  );
}
