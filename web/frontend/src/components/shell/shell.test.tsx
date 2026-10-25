// web/frontend/src/components/shell/shell.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TopNav, NAV_TABS } from "@/components/shell/TopNav";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TopNav />
    </MemoryRouter>,
  );
}

describe("TopNav", () => {
  it("declares the five КОРПУС tabs in order", () => {
    expect(NAV_TABS.map((t) => t.label)).toEqual([
      "Новый анализ",
      "Результаты",
      "История",
      "Сравнение",
      "Чат с агентом",
    ]);
  });

  it("renders the official КОРПУС logo image", () => {
    renderAt("/");
    const logo = screen.getByRole("img", { name: "КОРПУС" });
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("src", "/korpus-logo.png");
  });

  it("renders all five tab links plus the settings gear", () => {
    renderAt("/chat");
    for (const t of NAV_TABS) expect(screen.getByRole("link", { name: t.label })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Настройки" })).toBeInTheDocument();
  });

  it("marks the active tab in КОРПУС blue and leaves inactive tabs grey", () => {
    renderAt("/chat");
    const chat = screen.getByRole("link", { name: "Чат с агентом" });
    expect(chat.className).toContain("text-korpus-blue");
    const other = screen.getByRole("link", { name: "История" });
    expect(other.className).not.toContain("text-korpus-blue");
    expect(other.className).toContain("text-muted-foreground");
  });

  it("points each tab to its route", () => {
    renderAt("/chat");
    expect(screen.getByRole("link", { name: "Чат с агентом" })).toHaveAttribute("href", "/chat");
    expect(screen.getByRole("link", { name: "Новый анализ" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Настройки" })).toHaveAttribute("href", "/settings");
  });
});
