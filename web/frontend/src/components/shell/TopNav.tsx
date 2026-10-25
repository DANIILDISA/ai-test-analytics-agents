// web/frontend/src/components/shell/TopNav.tsx
import { NavLink } from "react-router-dom";
import {
  BarChart3,
  FileText,
  Clock,
  Scale,
  MessageCircle,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface NavTab {
  label: string;
  to: string;
  icon: LucideIcon;
}

export const NAV_TABS: NavTab[] = [
  { label: "Новый анализ", to: "/", icon: BarChart3 },
  { label: "Результаты", to: "/results", icon: FileText },
  { label: "История", to: "/history", icon: Clock },
  { label: "Сравнение", to: "/compare", icon: Scale },
  { label: "Чат с агентом", to: "/chat", icon: MessageCircle },
];

/** Official КОРПУС lockup served from /korpus-logo.png. */
function Brand() {
  return (
    <div className="flex items-center gap-3">
      <img
        src="/korpus-logo.png"
        alt="КОРПУС"
        className="max-h-[40px] w-auto shrink-0 object-contain sm:max-h-[52px]"
      />
    </div>
  );
}

export function TopNav() {
  return (
    <header className="flex h-[68px] shrink-0 items-center gap-3 border-b border-border bg-background px-3 font-korpus md:gap-6 md:px-6">
      <Brand />

      <nav className="ml-auto flex items-center gap-4 md:gap-6">
        {NAV_TABS.map((t) => {
          const Icon = t.icon;
          return (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.to === "/"}
              title={t.label}
              className={({ isActive }) =>
                cn(
                  "group relative flex items-center gap-2 py-[22px] text-sm transition-colors",
                  isActive
                    ? "font-semibold text-korpus-blue"
                    : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} />
                  {/* Phones: icons only. Tablets: + the active tab's name. Desktop: every label. */}
                  <span
                    className={cn(
                      "whitespace-nowrap",
                      isActive ? "sr-only md:not-sr-only" : "sr-only lg:not-sr-only",
                    )}
                  >
                    {t.label}
                  </span>
                  {/* Active underline indicator. */}
                  <span
                    aria-hidden
                    className={cn(
                      "pointer-events-none absolute inset-x-0 -bottom-px h-[3px] rounded-full bg-korpus-blue transition-opacity",
                      isActive ? "opacity-100" : "opacity-0",
                    )}
                  />
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      <NavLink
        to="/settings"
        aria-label="Настройки"
        className={({ isActive }) =>
          cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-korpus transition-colors",
            isActive
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )
        }
      >
        <Settings className="h-5 w-5" strokeWidth={1.75} />
        <span className="sr-only">Настройки</span>
      </NavLink>
    </header>
  );
}
