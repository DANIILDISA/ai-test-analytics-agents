// web/frontend/src/components/chat/EffortSelector.tsx
import { cn } from "@/lib/utils";
import type { Effort } from "@/types/chat";

const LEVELS: Array<{ value: Effort; label: string }> = [
  { value: "low", label: "Низкий" },
  { value: "medium", label: "Средний" },
  { value: "high", label: "Высокий" },
];

export interface EffortSelectorProps {
  value: Effort;
  onChange: (e: Effort) => void;
}

export function EffortSelector({ value, onChange }: EffortSelectorProps) {
  return (
    <div className="inline-flex overflow-hidden rounded-korpus border border-border">
      {LEVELS.map((l) => (
        <button
          key={l.value}
          type="button"
          onClick={() => onChange(l.value)}
          className={cn(
            "px-2.5 py-1 text-[11px] font-medium transition-colors",
            value === l.value ? "bg-korpus-blue text-white" : "bg-card text-muted-foreground hover:bg-muted",
          )}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
