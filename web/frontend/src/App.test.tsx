// web/frontend/src/App.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "@/App";

afterEach(() => vi.restoreAllMocks());

describe("App routes", () => {
  it("redirects the removed /export tab to the results page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }) as Response),
    );
    render(
      <MemoryRouter initialEntries={["/export"]}>
        <App />
      </MemoryRouter>,
    );
    // Results with no saved analyses shows its empty state (and there is no Экспорт tab at all).
    expect(await screen.findByText("Пока нет ни одного анализа")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Экспорт" })).not.toBeInTheDocument();
  });
});
