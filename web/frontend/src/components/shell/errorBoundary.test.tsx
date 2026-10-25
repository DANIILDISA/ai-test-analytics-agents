// web/frontend/src/components/shell/errorBoundary.test.tsx
// A render crash must surface as an honest, recoverable Russian screen — NOT a blank
// white page (React unmounts the tree on an uncaught error). The boundary also clears
// itself when the route (resetKey) changes so the app stays usable.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "@/components/shell/ErrorBoundary";

function Boom({ when = true }: { when?: boolean }): JSX.Element {
  if (when) throw new Error("тестовый сбой экрана");
  return <div>живой экран</div>;
}

afterEach(() => vi.restoreAllMocks());

describe("ErrorBoundary", () => {
  it("renders an honest fallback (with the message) instead of a blank page", () => {
    // React logs the caught error; silence it so the test output stays clean.
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Что-то пошло не так на этом экране")).toBeInTheDocument();
    expect(screen.getByText("тестовый сбой экрана")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Попробовать снова" })).toBeInTheDocument();
  });

  it("renders children normally when nothing throws", () => {
    render(
      <ErrorBoundary>
        <Boom when={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("живой экран")).toBeInTheDocument();
    expect(screen.queryByText("Что-то пошло не так на этом экране")).not.toBeInTheDocument();
  });

  it("clears the error when resetKey changes (route navigation)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { rerender } = render(
      <ErrorBoundary resetKey="/results">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Что-то пошло не так на этом экране")).toBeInTheDocument();

    // Navigating to a healthy route clears the boundary and shows the new screen.
    rerender(
      <ErrorBoundary resetKey="/history">
        <Boom when={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("живой экран")).toBeInTheDocument();
    expect(screen.queryByText("Что-то пошло не так на этом экране")).not.toBeInTheDocument();
  });
});
