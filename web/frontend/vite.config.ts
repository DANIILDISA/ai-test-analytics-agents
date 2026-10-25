/// <reference types="vitest/config" />
import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import type { IncomingMessage } from "node:http";

// API base for the dev proxy. The SPA calls bare relative paths (fetch("/threads"),
// POST "/chat" SSE, etc.); in `vite dev` those must reach the FastAPI backend instead of
// the Vite dev server. The backend (uvicorn web.app:app) defaults to 127.0.0.1:8000, but
// set VITE_API_TARGET (e.g. http://127.0.0.1:8010) to point at a backend on another port
// when 8000 is taken (the user's Docker stack binds 8000).
const API_TARGET = process.env.VITE_API_TARGET ?? "http://127.0.0.1:8000";
// Paths owned by the КОРПУС C2 backend (web/api.py) + the v0.1 Jinja/JSON routes
// (web/app.py): /chat & /chat/confirm (SSE + JSON), /threads(+/:id), /settings, plus the
// v0.1 /analyze, /compare, /history, /download. Prefix-matched, so /chat covers
// /chat/confirm and /threads covers /threads/:id.
const API_PATHS = ["/chat", "/threads", "/settings", "/analyze", "/compare", "/runs", "/history", "/download"];

// Several of these paths (/chat, /compare, /settings, /history) ALSO exist as client-side
// React Router routes. So we must not blindly forward every request: a hard browser reload
// at /settings should serve the SPA's index.html, while the SPA's fetch()/SSE API calls to
// the same path must reach the backend. `bypass` disambiguates by intent — a top-level
// browser navigation sends `Accept: text/html` (and is a GET); we let those fall through to
// the Vite dev server (return the path → serve index.html). Everything else (POST, or fetch
// with Accept: application/json / text/event-stream) is proxied to FastAPI. `changeOrigin`
// keeps SSE (/chat) streaming correctly.
const apiProxy: ProxyOptions = {
  target: API_TARGET,
  changeOrigin: true,
  bypass(req: IncomingMessage) {
    const accept = String(req.headers.accept ?? "");
    const isBrowserNav = (req.method ?? "GET") === "GET" && accept.includes("text/html");
    if (isBrowserNav) return req.url ?? "/"; // serve the SPA's index.html, do not proxy
    return undefined; // proxy this API request to the backend
  },
};

const apiProxies: Record<string, ProxyOptions> = Object.fromEntries(
  API_PATHS.map((p) => [p, { ...apiProxy }]),
);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { proxy: apiProxies },
  build: { outDir: "dist", emptyOutDir: true },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: true,
  },
});
