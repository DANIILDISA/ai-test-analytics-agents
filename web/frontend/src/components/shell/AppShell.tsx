// web/frontend/src/components/shell/AppShell.tsx
import { Outlet, useLocation } from "react-router-dom";
import { TopNav } from "@/components/shell/TopNav";
import { ErrorBoundary } from "@/components/shell/ErrorBoundary";

export function AppShell() {
  const location = useLocation();
  return (
    <div className="flex h-screen flex-col">
      <TopNav />
      <main className="min-h-0 flex-1">
        {/* A render crash on one screen must not blank the whole app — the boundary
            keeps the nav usable and clears itself when the route changes. */}
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
