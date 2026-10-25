# KORPUS — AI Agents for Test Results Analytics

> 🏆 **1st place, "AI Agents" track** — Case Championship of the St. Petersburg Corporate University (2026).
> 🇷🇺 Русская версия: [README.ru.md](README.ru.md)

A multi-agent system that analyzes e-learning test results for course methodologists. It takes raw LMS exports, checks answers against the reference key, finds problem questions and suspicious attempt patterns, and produces ready-to-use reports — plus a chat assistant that answers questions strictly from the analysis data.

**Design principle — "code first, AI last":** all calculations are deterministic Python; LLM calls are minimal, cached, and configurable. The output is reproducible and cheap to run.

## What it does

- **Answer checking** against the reference key: single/multiple choice, matching, ranking — deterministic; free-text answers — with an LLM. Match score in % / points.
- **Critical questions** — questions with mass errors are flagged automatically.
- **Attempt analysis** — score distribution, abnormal attempt patterns (number of attempts, score spread), drop-off rate; timing anomalies when the export contains timing data.
- **Reports** — JSON (machine-readable), **Excel with color-highlighted deviations**, text report; breakdowns by course and group.
- **Chat agent** — answers the methodologist's questions using only the analysis results, compares runs, builds trends, can launch a new analysis on confirmation and assemble a report.
- **Two LLM provider groups** — Russian (**GigaChat**) and international (**OpenRouter**), switchable in settings.
- **Inputs** — `.xlsx`, `.json`, `.csv`, a single file or a whole folder; malformed data produces warnings instead of crashes.
- **Interfaces** — web UI and CLI.

## Architecture

```
              input (.xlsx / .json / .csv / folder)
                            │
                pipeline.data_loader → CourseData (+ validate)
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
      answer_agent                      time_agent
  (reference check,               (medians, time and
   critical questions)             attempt anomalies)
            └───────────────┬───────────────┘
                            ▼
        report_agent  +  insight_agent (LLM insights)
                            │
          reports: JSON · Excel (highlighting) · text · history
                            │
        web (FastAPI + React SPA)  /  chat_agent  /  CLI
```

Five agents: `answer_agent`, `time_agent`, `report_agent` (deterministic analysis), `insight_agent` (LLM commentary) and `chat_agent` (conversational assistant with streaming responses).

## Tech stack

- **Backend:** Python 3.10+, FastAPI, Uvicorn, Pydantic, openpyxl, python-docx, RapidFuzz
- **LLM:** GigaChat SDK, OpenAI-compatible client (OpenRouter), response caching, token budgets in `config.yaml`
- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS, Recharts, SSE streaming; Vitest + Testing Library
- **Delivery:** one-click `START.bat` / `start.sh` launcher, Dockerfile + docker-compose

~10k lines of Python.

## Quick start

```bash
git clone https://github.com/DANIILDISA/ai-test-analytics-agents.git
cd ai-test-analytics-agents
cp .env.example .env      # optional: add OpenRouter / GigaChat keys for LLM features
./start.sh                # Windows: double-click START.bat
```

The launcher creates a virtual environment, installs dependencies, starts the server and opens the browser. Without API keys everything except the LLM features works. Sample data is in `data/`.

## Repository layout

```
agents/     answer_agent, time_agent, report_agent, insight_agent, chat_agent
pipeline/   data loading/parsing, orchestration (runner), statistics
core/       config, settings, domain models, run history
models/     LLM provider adapters (OpenRouter / GigaChat)
web/        FastAPI API + React SPA (frontend/)
data/       anonymized sample exports and reference keys
docs/       user, admin and developer guides (in Russian)
```

## Author

**Daniil Burnashov** — design, development and documentation.
