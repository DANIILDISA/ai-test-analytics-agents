import type { Config } from "tailwindcss";

// КОРПУС theme reads from CSS variables defined in src/styles/tokens.css so the
// design system has a single source of truth. hsl(var(--token)) lets Tailwind
// utilities (bg-korpus-blue, text-fg, etc.) resolve to the extracted brand values.
const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        muted: "hsl(var(--muted))",
        "muted-foreground": "hsl(var(--muted-foreground))",
        border: "hsl(var(--border))",
        card: "hsl(var(--card))",
        "card-foreground": "hsl(var(--card-foreground))",
        korpus: {
          blue: "hsl(var(--korpus-blue))",
          "blue-hover": "hsl(var(--korpus-blue-hover))",
          up: "hsl(var(--korpus-up))",
          down: "hsl(var(--korpus-down))",
        },
      },
      borderRadius: {
        korpus: "var(--radius-korpus)",
      },
      fontFamily: {
        korpus: "var(--font-korpus)",
      },
    },
  },
  plugins: [],
};

export default config;
