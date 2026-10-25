"""Production server — one Python process serving the React SPA **and** the JSON API.

The polished КОРПУС interface is a React/Vite single-page app. In development it runs
under the Vite dev server (``npm run dev``, port 5173) which proxies API calls to the
FastAPI backend. For a no-Node handoff we instead serve the *prebuilt* bundle
(``web/frontend/dist``, produced by ``npm run build``) straight from FastAPI, so the whole
product launches with a single ``uvicorn web.serve:app`` — Python only, no Node at runtime.

Routing model (mirrors the Vite dev proxy's ``bypass`` rule):

* The JSON API (``web.api.build_router``) and report downloads (``web.app.download_router``)
  are mounted first, so every API call wins.
* The SPA's client-side routes (``/``, ``/results``, ``/history`` …) collide with the API
  on exactly one path — ``GET /settings`` (API returns JSON; the SPA also has a ``/settings``
  screen). A top-level browser navigation sends ``Accept: text/html``; the SPA's ``fetch``
  sends ``Accept: application/json``. The middleware below serves ``index.html`` for the
  former and lets the latter fall through to the API — so a hard reload on any SPA route
  shows the app, while data calls still reach the backend.
* Built static assets are served from ``/assets``; any other unmatched GET returns a real
  file if present (favicon, logo) else the SPA shell.

LLM features still need keys in ``.env``; default analyses are free (code-only) and run
without any key, so the app is fully usable on a fresh machine with no secrets configured.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from web.api import build_router
from web.app import _agent_client_factory, _agent_rerun, download_router

DIST = Path(__file__).resolve().parent / "frontend" / "dist"
INDEX = DIST / "index.html"

# Client-side routes declared in the SPA router (web/frontend/src/App.tsx). A browser
# navigation to any of these must serve the SPA shell rather than 404 or hit the API.
SPA_ROUTES = frozenset({"/", "/results", "/history", "/compare", "/chat", "/export", "/settings"})

_NO_CACHE = {"Cache-Control": "no-store", "Vary": "Accept"}

app = FastAPI(title="КОРПУС — анализ результатов тестирования")


@app.middleware("http")
async def _spa_html_first(request: Request, call_next):
    """Serve the SPA shell for browser navigations to client-side routes.

    Only intercepts ``GET`` requests whose ``Accept`` prefers HTML and whose path is a
    known SPA route. The SPA's own ``fetch``/SSE calls (``Accept: application/json`` or
    ``text/event-stream``) skip this and reach the JSON API — including ``GET /settings``.
    """
    if (
        request.method == "GET"
        and request.url.path in SPA_ROUTES
        and "text/html" in request.headers.get("accept", "")
    ):
        return FileResponse(INDEX, headers=_NO_CACHE)
    response = await call_next(request)
    if request.url.path in SPA_ROUTES:
        # «/settings» is both an SPA page and a JSON endpoint on ONE url. Without these headers
        # a browser may answer the JSON fetch from the cached HTML page (or vice versa) and the
        # screen shows «Unexpected token '<'» — so tell every cache the answer depends on Accept.
        for k, v in _NO_CACHE.items():
            response.headers[k] = v
    return response


# JSON API + report downloads first, so /chat, /runs, /settings (JSON), /download/* win.
app.include_router(
    build_router(agent_client_factory=_agent_client_factory, rerun=_agent_rerun)
)
app.include_router(download_router)

# Hashed JS/CSS produced by `vite build`.
if (DIST / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=str(DIST / "assets")), name="assets")


@app.get("/{full_path:path}")
def _spa_fallback(full_path: str):
    """Serve a real built file if it exists (favicon, logo, robots), else the SPA shell."""
    if full_path:
        candidate = (DIST / full_path).resolve()
        # Stay inside dist/ — never serve files outside the bundle on a crafted path.
        if candidate.is_file() and DIST.resolve() in candidate.parents:
            return FileResponse(candidate)
    return FileResponse(INDEX)
