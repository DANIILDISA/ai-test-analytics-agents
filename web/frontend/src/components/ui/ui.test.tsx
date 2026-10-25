// web/frontend/src/components/ui/ui.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

describe("ui primitives", () => {
  it("Button renders children and applies КОРПУС blue by default", () => {
    render(<Button>Отправить</Button>);
    const btn = screen.getByRole("button", { name: "Отправить" });
    expect(btn.className).toContain("bg-korpus-blue");
  });

  it("Button outline variant drops the filled brand background", () => {
    render(<Button variant="outline">Отмена</Button>);
    const btn = screen.getByRole("button", { name: "Отмена" });
    expect(btn.className).not.toContain("bg-korpus-blue");
    expect(btn.className).toContain("border");
  });

  it("Card + CardTitle render a titled surface", () => {
    render(
      <Card>
        <CardTitle>Сводка</CardTitle>
      </Card>,
    );
    expect(screen.getByText("Сводка")).toBeInTheDocument();
  });

  it("Input forwards placeholder and value", () => {
    render(<Input placeholder="Спросите агента…" defaultValue="привет" />);
    const input = screen.getByPlaceholderText("Спросите агента…") as HTMLInputElement;
    expect(input.value).toBe("привет");
  });
});
