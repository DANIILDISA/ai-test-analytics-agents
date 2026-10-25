# КОРПУС — руководство разработчика

Техническая документация по коду проекта **КОРПУС** (Корпоративный университет
Санкт-Петербурга) — «группа ИИ-агентов для анализа результатов тестовых заданий».
Документ предназначен для стороннего разработчика (Python / JS): архитектура, сборка,
запуск, расширение и сопровождение.

Все упомянутые пути и имена функций проверены по исходному коду на момент написания.
Базовая директория проекта далее — корень репозитория.

---

## 1. Назначение и область применения

Система автоматически анализирует результаты прохождения тестов слушателями электронных
курсов LMS и формирует отчёты для методиста. Конкретно:

- **Проверка ответов** против эталона. LMS уже выставила вердикт по каждому ответу
  (`result_code`), поэтому код не переоценивает выбор/сопоставление/ранжирование — он лишь
  нормализует широкий Excel-экспорт в записи. ИИ привлекается только к свободным ответам
  (текст / число), да и то опционально (см. раздел 7).
- **Анализ попыток**: распределение баллов по тестам, доля брошенных попыток, аномалии
  паттернов попыток, посписочный rollup по студентам. Полноценного анализа времени нет —
  экспорт LMS не содержит длительностей на вопрос (агент сообщает об этом в выводе).
- **Поиск критических вопросов** — вопросов с долей верных ответов ниже порога при
  достаточной выборке.
- **Формирование отчётов**: JSON, Excel с цветной подсветкой проблемных ячеек, plain-text
  на русском.
- **Чат-агент** — ассистент методиста, отвечающий строго по сохранённым результатам анализа
  набором инструментов (numbers from code, never the LLM).

Ключевой принцип — **code-first, LLM-last**: основные расчёты выполняет детерминированный
код; LLM по умолчанию не вызывается (0 токенов). Ничего о моделях, ключах, порогах и путях
не захардкожено в Python — всё приходит из `config.yaml` + `.env` (+ UI-оверлей).

---

## 2. Технологический стек и требования к окружению

### Backend (Python)

| Компонент | Назначение | Минимальная версия (из `requirements.txt`) |
|---|---|---|
| Python | среда исполнения | 3.10+ (`scripts/launch.py` проверяет ≥3.10; цель проекта — 3.12) |
| `pydantic` | доменные модели, конфиг (v2) | `>=2.13` |
| `pydantic-settings` | вспомогательное | `>=2.14` |
| `openpyxl` | Excel-парсинг и Excel-отчёт | `>=3.1` |
| `openai` | OpenRouter (группа `foreign`) через OpenAI-совместимый API | `>=2.0` |
| `pyyaml` | парсинг `config.yaml` | `>=6.0` |
| `python-dotenv` | загрузка `.env` | `>=1.0` |
| `rapidfuzz` | нечёткое сопоставление с эталоном | `>=3.14` |
| `gigachat` | официальный Sber SDK (группа `russian`) | `>=0.2` |
| `fastapi` | веб-слой | `>=0.115` |
| `uvicorn` | ASGI-сервер | `>=0.30` |
| `python-multipart` | загрузка файлов | `>=0.0.9` |
| `jinja2` | legacy-шаблоны прототипа v0.1 | `>=3.1` |
| `pytest` | тесты | `>=8.0` |

Проверенный рабочий набор версий зафиксирован в комментарии в конце `requirements.txt`.
Смоук-тест `tests/test_imports_smoke.py` падает, если какой-то пакет отсутствует.

### Frontend (`web/frontend/`, из `package.json`)

React 18.3 + Vite 6 + TypeScript 5.6 + TailwindCSS 3.4 + Recharts 2.15 +
`react-router-dom` 6.28; SSE-парсинг — `eventsource-parser`; иконки — `lucide-react`.
Тесты — Vitest 2.1 + Testing Library + jsdom. Для продакшен-поставки фронтенд собирается
заранее (`npm run build` → `web/frontend/dist`), и Node в рантайме не нужен.

---

## 3. Высокоуровневая архитектура

Система делится на два слоя:

- **C1 — движок** (детерминированное ядро): `core/`, `pipeline/`, `agents/answer_agent`,
  `agents/time_agent`, `agents/report_agent`, `agents/insight_agent`, `models/`, CLI
  `main.py`.
- **C2 — веб и чат** (КОРПУС): `web/`, `agents/chat_agent`, `web/frontend/` (React-SPA).
  C2 — надстройка над C1; чат-агент работает инструментами поверх сохранённых прогонов.

```
                ┌──────────────────────────── C2 (веб + чат) ────────────────────────────┐
                │  web/frontend (React-SPA)                                               │
                │     │  fetch / SSE                                                       │
                │  web/serve.py  (прод: SPA + JSON-API в одном процессе)                  │
                │  web/app.py    (legacy Jinja-прототип v0.1)                             │
                │     ├── web/api.py    build_router → /threads /settings /runs           │
                │     │                 /analyze /compare /chat (SSE) /chat/confirm        │
                │     ├── web/service.py  run_analysis (обёртка над C1 + insight)          │
                │     └── agents/chat_agent  loop / tools / threads / react                │
                └─────────────────────────────────┬───────────────────────────────────────┘
                                                  │ читает сохранённые прогоны
                ┌─────────────────────────────────┴──── C1 (движок) ──────────────────────┐
                │  main.py (CLI)                                                            │
                └──────────────────────────────────────────────────────────────────────────┘
```

Поток данных вход → анализ → отчёт:

```
вход (.xlsx | .json | .csv ; файл или папка)
   │
   ▼  pipeline.data_loader.load(input_path, reference_path)
list[CourseData]  (attempts: list[StudentAttempt], reference: dict[test][q] -> ReferenceAnswer)
   │
   ▼  CourseData.validate()                    # мягкий гейт, русские сообщения, НЕ бросает
   │
   ▼  pipeline.runner.run_all → run_course
   ├── agents.answer_agent.analyze(...)        # сравнение ответов, критические вопросы
   └── agents.time_agent.analyze(...)          # попытки, баллы, аномалии, rollup
   │
   ▼  result: dict  {course_id, answer{...}, time{...}}
   │
   ├── (опц.) agents.insight_agent.comment / suggest_inputs / compare   # ИИ-выводы
   │
   ▼  agents.report_agent
   ├── generator.write_reports → report_<id>.json + report_<id>.txt
   ├── generator.render_text   → plain-text
   └── excel_generator.build_excel → .xlsx с подсветкой
   │
   ▼  core.history.save_run → output/history/<id>/report.json + index.json
   │
   ▼  agents.chat_agent (инструменты поверх сохранённых прогонов)
```

LLM-клиент и функция перезапуска анализа **инжектируются** в HTTP-роутер (`build_router`),
поэтому веб-слой не импортирует реального провайдера и полностью тестируется на фейках.

---

## 4. Карта репозитория

Только реально существующие пути; по одной строке ответственности на модуль.

### `core/` — фундамент
| Путь | Ответственность |
|---|---|
| `core/models.py` | Pydantic-модели домена: `StudentAttempt`, `QuestionAnswer`, `ReferenceAnswer`, enum `QuestionType`, `ResultCode` |
| `core/config.py` | Загрузка `config.yaml` + резолв секретов из `.env`: `AppConfig`, `ModelConfig`, `Thresholds`, `Paths`, `load_config`, `ConfigError` |
| `core/settings.py` | Пер-компонентный UI-оверлей (`analysis`/`insight`/`chat_agent`): `resolve_component`, `resolve_key`, `ui_view`, `load_overlay`/`save_overlay`, `mask_secret` |
| `core/history.py` | Файловое хранилище прогонов `output/history/<id>/report.json` + `index.json`: `save_run`, `load_run`, `list_runs` |
| `core/exceptions.py` | Базовое исключение `TestAnalyzerError` и `ParseError` |

### `pipeline/` — загрузка и статистика
| Путь | Ответственность |
|---|---|
| `pipeline/data_loader.py` | Входная «дверь»: `load(input_path, reference_path) -> list[CourseData]`; обход файла/папки, классификация массив/эталон по имени, диспетчеризация по расширению; `CourseData.validate()` |
| `pipeline/runner.py` | Оркестратор: `run_course`, `run_all`, `RunOptions`, `usage_total_tokens`, `budget_exceeded` |
| `pipeline/stats.py` | Слой-2 статистика (0 токенов): `question_stats`, `course_summary`, `QuestionStat` |
| `pipeline/parsers/answer_array_parser.py` | `parse_answer_array(filepath, course_id) -> list[StudentAttempt]` (широкий .xlsx «Массив») |
| `pipeline/parsers/reference_parser.py` | `parse_reference(filepath) -> dict[test][q] -> ReferenceAnswer` (.xlsx «Эталон») |
| `pipeline/parsers/json_parser.py` | `parse_json_answers`, `parse_json_reference` |
| `pipeline/parsers/csv_parser.py` | `parse_csv_answers`, `parse_csv_reference` |
| `pipeline/parsers/excel_utils.py` | Утилиты чтения ячеек и `normalize_question` (нормализация текста вопроса) |

### `agents/` — агенты
| Путь | Ответственность |
|---|---|
| `agents/answer_agent/__init__.py` | Агент 1, точка входа `analyze(...)`: сравнение ответов, критические вопросы, ИИ-разбор свободных ответов |
| `agents/answer_agent/comparator.py` | LLM-вердикты: `review_answer`, `review_answers_batch`, `PROMPT_VERSION` |
| `agents/answer_agent/scorer.py` | Детерминированный `text_similarity` (fallback) |
| `agents/answer_agent/reference_match.py` | `match_acceptable` — exact / number / set / fuzzy сопоставление с эталоном |
| `agents/answer_agent/pattern_detector.py` | `is_critical`, `common_errors` |
| `agents/answer_agent/cache.py` | `AnswerCache` — персистентный JSON-кэш вердиктов (детерминизм/экономия) |
| `agents/time_agent/__init__.py` | Агент 2, `analyze(...)`: баллы по тестам, аномалии попыток, доля брошенных, rollup по студентам |
| `agents/time_agent/analyzer.py` | `per_test_scores` (распределение баллов по тестам) |
| `agents/time_agent/anomaly_detector.py` | `attempt_anomalies` |
| `agents/report_agent/generator.py` | `write_reports`, `render_text` (JSON + текст) |
| `agents/report_agent/report_model.py` | Модель содержимого Word/PDF-отчёта (KPI, 4 ИИ-блока, критические вопросы, методика) |
| `agents/report_agent/docx_report.py` / `pdf_report.py` | Word (python-docx) и PDF (печать HTML установленным Chromium-браузером) |
| `agents/report_agent/excel_generator.py` | `build_excel(result, sections) -> bytes` — Excel с цветной подсветкой |
| `agents/report_agent/visualizer.py` | Вспомогательная визуализация / подсветка |
| `agents/insight_agent/__init__.py` | Агент 4 (ИИ-выводы): `comment`, `suggest_inputs`, `compare`, `compute_diff`, `detect_gaps`, `InsightOptions`, `BLOCK_KEYS`, `BLOCK_TITLES` |
| `agents/insight_agent/commentary.py` / `suggestions.py` / `comparison.py` / `options.py` | Реализации блоков ИИ-выводов и опции |
| `agents/insight_agent/prompts/*.yaml` | Промпты (commentary / suggestions / comparison), загружаются `prompt_loader.py` |
| `agents/chat_agent/loop.py` | Ограниченный tool-calling цикл: `run_turn` (синхр.) и `stream_turn` (потоковый), `LoopResult`, гейт подтверждения `run_analysis` |
| `agents/chat_agent/tools.py` | Инструменты агента + `build_registry` (13 инструментов над данными C1) |
| `agents/chat_agent/threads.py` | Файловое хранилище диалогов `output/chats/`: `new_thread`, `save_thread`, `load_thread`, `list_threads`, `delete_thread`, `context_run_ids`, `uploads_dir` |
| `agents/chat_agent/protocol.py` | Протокол `ToolCallingClient`, `AssistantTurn`, `ToolCall` |
| `agents/chat_agent/effort.py` | `step_budget(effort)` — бюджет шагов (low=2 / medium=4 / high=8) |

### `models/` — адаптеры провайдеров (НЕ доменные модели)
| Путь | Ответственность |
|---|---|
| `models/__init__.py` | Фабрики `get_client(config)` и `build_tool_client(mc)` |
| `models/base.py` | Протокол `LLMClient` + `LLMResult` (текст + токены/стоимость) |
| `models/foreign/openrouter.py` | `OpenRouterClient.complete` (анализ/insight) |
| `models/foreign/openrouter_tools.py` | `OpenRouterToolClient.chat` — нативный function-calling (+ ReAct-fallback) |
| `models/russian/gigachat.py` | `GigaChatClient.complete` |
| `models/russian/gigachat_tools.py` | `GigaChatReActClient.chat` — tool-calling через ReAct |
| `models/react.py` | Провайдеро-независимый ReAct: `build_react_system`, `parse_react` |

### `web/` — веб-слой
| Путь | Ответственность |
|---|---|
| `web/serve.py` | **Продакшен-сервер**: SPA из `web/frontend/dist` + JSON-API одним процессом; Accept-aware middleware для SPA-маршрутов |
| `web/app.py` | Legacy Jinja-прототип v0.1 (`/`, `/analyze`, `/history`, `/compare`) + `download_router`; фабрики `_agent_client_factory`, `_agent_rerun` |
| `web/api.py` | `build_router` — JSON/SSE-API для React-SPA |
| `web/service.py` | `run_analysis(...)` — стейджинг загрузок → C1 runner → insight → history; `Upload`, `modes_from` |
| `web/chat_sse.py` | Адаптация хода чата в SSE: `sse_frame`, `frames_for_result`, `SSE_EVENTS` |
| `web/templates/*.html` | Шаблоны legacy-прототипа |

### `web/frontend/` — React-SPA
| Путь | Ответственность |
|---|---|
| `src/App.tsx` | Маршруты SPA (`/`, `/results`, `/history`, `/compare`, `/chat`, `/settings`; `/export` → редирект на `/results`) |
| `src/screens/` | Экраны: `NewAnalysis`, `Results`, `History`, `Comparison`, `Settings`, `Stub` |
| `src/components/chat/` | UI чата: `ChatScreen`, `MessageList`, `Composer`, `ThreadSidebar`, `ConfirmDialog`, `EffortSelector`, `ContextBar`, `BlockList` |
| `src/components/cards/` | Карточки результатов: `StatsCard`, `ListCard`, `CompareCard`, `RunsCard`, `CardView` |
| `src/components/shell/` | Каркас: `AppShell`, `TopNav`, `ErrorBoundary` |
| `src/api/client.ts`, `src/api/chatStream.ts` | HTTP-клиент и SSE-стрим чата |

### Прочее
| Путь | Ответственность |
|---|---|
| `main.py` | CLI-точка входа |
| `config.yaml` | Несекретные настройки (группа, модели, пороги, бюджеты, батч) |
| `.env.example` | Шаблон секретов (значения не коммитятся) |
| `scripts/launch.py` | Однофайловый запуск (venv → deps → `web.serve:app` → браузер) |
| `START.bat` / `start.sh` | Обёртки над `scripts/launch.py` |
| `data/` | Реальные образцы LMS (`samples/`, `etalon/`, `samples_jsoncsv/`) |
| `tests/` | pytest-набор + фейки и фикстуры |
| `tests/golden/report_069.json` | Золотая фикстура курса 069 |

---

## 5. Доменная модель данных

Все модели — Pydantic v2 (`core/models.py`). Они держатся близко к сырому экспорту LMS:
LMS уже оценила каждый ответ, поэтому модели только нормализуют, не переоценивают.

### `QuestionType` (enum, значение = русская метка типа вопроса)
`SINGLE_CHOICE` «единственный выбор», `MULTI_CHOICE` «множественный выбор`,
`TEXT_INPUT` «текстовый ввод», `NUMERIC_INPUT` «числовой ввод`, `MATCHING` «соответствие`,
`RANKING` «ранжирование`, `UNKNOWN` «неизвестно».
- `from_raw(raw)` — терпимый маппинг (регистр/пробелы), неизвестный тип → `UNKNOWN`
  (страховка от падения парсинга).
- свойство `needs_semantic_check` истинно **только** для `TEXT_INPUT` и `NUMERIC_INPUT` —
  именно их неверные ответы могут уйти на ИИ-разбор. Выбор/ранжирование/сопоставление
  оценены кодом LMS и в LLM не отправляются.

### `ResultCode` (enum)
Вердикт LMS из ячейки «Результат»: `CORRECT = "lcnwu5wcgk"`, `WRONG = "r1s987zw3e"`.
`from_raw` возвращает `None`, если код отсутствует/неизвестен.

### `QuestionAnswer`
Один ответ студента на один вопрос: `question_text`, `question_type`,
`result_code: ResultCode | None`, `given_answer`, `correct_answer`, `is_answered`.
Вычисляемые `is_correct` / `is_wrong` (по `result_code`).

### `StudentAttempt`
Одна попытка (строка листа «Массив»): `attempt_id`, `student_id`, `course_id`, `test_name`,
`attempt_date: datetime | None`, `score_points`, `score_max`, `score_pct`, `status`,
`is_abandoned`, `answers: list[QuestionAnswer]`.
Свойства: `is_passed` (status == «пройден»), вычисляемые `answered_count`, `correct_count`,
`wrong_count`.

### `ReferenceAnswer`
Запись эталона: `test_name`, `question_text`, `raw_answer` (исходная ячейка),
`acceptable: list[str]` (расщеплённые допустимые варианты).

### Форматы входа и где парсятся

| Формат | Парсер ответов | Парсер эталона |
|---|---|---|
| `.xlsx` (широкий экспорт LMS) | `pipeline/parsers/answer_array_parser.py` | `pipeline/parsers/reference_parser.py` |
| `.json` | `pipeline/parsers/json_parser.py` | то же |
| `.csv` | `pipeline/parsers/csv_parser.py` | то же |

Все три формата дают **одни и те же** объекты `StudentAttempt` / `ReferenceAnswer`, поэтому
остальной движок форматонезависим. Образцы: `data/samples/*` (.xlsx),
`data/samples_jsoncsv/*` (.json/.csv). Подробное описание форматов и их особенностей —
в `docs/input_formats.md`.

---

## 6. Конвейер анализа

### 6.1 `data_loader.load(input_path, reference_path=None) -> list[CourseData]`

- Принимает файл или папку (рекурсивный обход); whitelist расширений
  `(.xlsx, .json, .csv)`; пропускает Office-локи `~$...`.
- `course_id` = имя родительской папки (раскладка `data/{samples,etalon}/<course>/`).
- Классификация по имени файла: содержит `эталон` → эталон, иначе → массив (по умолчанию
  неизвестные считаются массивом).
- Диспетчеризация по расширению (`_parse_answers` / `_parse_ref`). Любая ошибка парсинга
  одного файла превращается в `warning`, а не в аварию всего прогона (`ParseError`
  собирается в `CourseData.warnings`).

`CourseData` — `dataclass` с `course_id`, `attempts`, `reference`, `warnings` и методом
`validate() -> list[str]`. Это **мягкий гейт**: возвращает русские строки проблем, никогда
не бросает. Пустой список = курс годен. Эталон требуется только если есть свободные ответы
(`needs_semantic_check`) — поэтому курсы с выбором/сопоставлением проходят и без эталона.

### 6.2 `runner.run_all(courses, cfg, client, options, *, cache=None) -> list[(course, result|None, error|None)]`

- `RunOptions(modes={"answer","time"}, max_llm_calls=0)` — какие агенты запускать и лимит
  LLM-вызовов на курс.
- `run_course` вызывает `answer_agent.analyze` и/или `time_agent.analyze`, собирая
  `result: dict`.
- Каждый курс изолирован: падение одного (rate-limit, сетевой сбой) не прерывает остальные
  (partial results). После **каждого** курса вызывается `cache.save()`.
- `usage_total_tokens(usage)` и `budget_exceeded(usage, budget)` — учёт и advisory-проверка
  бюджета токенов (0/None = без лимита).

### 6.3 Агент 1 — `answer_agent.analyze(course, client=None, *, critical_rate, max_llm_calls, fuzzy_threshold, llm_batch_size, min_samples, top_errors, cache)`

Вход: `CourseData`. Выход — словарь `answer`:
`{course_id, analyzed_at, summary, questions[], llm_usage, warnings}`.

Логика по каждому уникальному вопросу (статистика из `pipeline.stats.question_stats`):
1. Считает `answered/correct/wrong/correct_rate`, флаг `critical` (`is_critical`), частые
   ошибки (`common_errors`).
2. Только для свободных типов с ошибками: фаза 1 — `match_acceptable` (exact / number / set /
   fuzzy) без токенов; фаза 2 — кэш-miss'ы судит LLM (`review_answer` /
   `review_answers_batch`), не больше `max_llm_calls` **вызовов**. Идентичные вердикты
   дедуплицируются через `AnswerCache`.
3. Строгие проверки аргументов (диапазоны `critical_rate`, `min_samples`, `fuzzy_threshold`)
   падают с понятным русским сообщением вместо тихой порчи прогона.
4. `_merge_questions_by_text` схлопывает один и тот же вопрос, встречающийся в разных тестах
   (листах), в одну строку с пересчётом `correct_rate`/`critical` по пулу.

`llm_usage`: `{calls, cache_hits, auto_matched, prompt_tokens, completion_tokens,
reasoning_tokens, cost}`. Если `client is None` или `max_llm_calls <= 0` — LLM не вызывается
(0 токенов).

### 6.4 Агент 2 — `time_agent.analyze(course, *, cfg=None)`

Экспорт LMS не содержит времени на вопрос, поэтому агент работает «с тем, что есть»:
`{course_id, note, tests, attempt_anomalies, abandoned_rate, students}`, где
- `tests` — распределение баллов по тестам (`per_test_scores`, в т.ч. `median_score`);
- `attempt_anomalies` — аномалии паттернов попыток (`attempt_anomalies`);
- `abandoned_rate` — доля брошенных попыток, %;
- `students` — посписочный rollup: по каждому студенту `best_score`, `attempts`, `status`
  (`completed` / `abandoned`).
`note` явно фиксирует ограничение по времени.

### 6.5 Агент 4 — insight (опционально)

`comment(result, options, client)`, `suggest_inputs(course, result, ...)`,
`compare(a, b, client)` рассуждают **над уже агрегированными** результатами (никогда над
сырыми ответами). Блоки выбирает пользователь (`InsightOptions`, ключи `BLOCK_KEYS`:
`diagnosis`, `why_failed`, `recommendations`, `anomalies`). Пустой выбор = LLM не вызывается
(`InsightOptions.active == False`).

### 6.6 Агент 3 — отчёты

`report_agent.generator.write_reports(result, out_dir, *, course_id)` пишет
`report_<course_id>.json` и `.txt`; `render_text(result)` — тот же текстовый рендер, что
использует и чат-инструмент `generate_report`. `excel_generator.build_excel(result,
sections=None) -> bytes` строит .xlsx с подсветкой: на листе «Вопросы» RED — критический
вопрос, GREEN — норма; на листе «Аномалии времени и попыток» BLUE/ORANGE — слишком
быстрая/медленная попытка, **когда тайминг доступен**, иначе лист показывает аномалии
паттернов попыток, а первой строкой выводится `time["note"]` (в текущей выгрузке LMS нет
времени по вопросам — лист об этом честно сообщает). Сборщик защитный — отсутствующая
секция/ключ пропускается, а не валит рендер.

---

## 7. Группы нейросетей

Кейс требует поддержки двух групп моделей. Обе реализуют один и тот же интерфейс, поэтому
агенты и пайплайн зависят только от протокола, а не от провайдера.

| Группа | Провайдер | Интеграция «инструментов» (чат) | Где задаётся |
|---|---|---|---|
| `russian` | GigaChat (Sber SDK) | **ReAct** (текстовый протокол, нативного function-calling нет) | `config.yaml` → `models.russian` |
| `foreign` | OpenRouter (OpenAI-совместимый) | **нативный function-calling** (+ ReAct-fallback, если у модели нет tools) | `config.yaml` → `models.foreign` |

Обоснование: «russian» нужна для сценария, когда данные должны оставаться в РФ-контуре;
«foreign» (по умолчанию `deepseek/deepseek-v4-flash`) — для качества/цены. Активная группа
задаётся ключом `model_group` в `config.yaml`, флагом CLI `--model-group`, либо пер-компонентно
через UI-оверлей (`core/settings.py`).

Две точки интеграции (`models/__init__.py`):
- `get_client(config) -> LLMClient` — клиент для анализа/insight (метод `complete(system,
  user) -> LLMResult`). OpenRouter → `OpenRouterClient`, GigaChat → `GigaChatClient`.
- `build_tool_client(mc) -> ToolCallingClient` — клиент для чата (метод `chat(messages,
  tools) -> AssistantTurn`). OpenRouter → `OpenRouterToolClient` (нативные tools, при
  отсутствии поддержки — ReAct-fallback), GigaChat → `GigaChatReActClient`.

ReAct (`models/react.py`): `build_react_system(base_system, tools)` рендерит каталог
инструментов и правила формата `Thought: / Action: / Action Input: / Final Answer:` в
системный промпт; `parse_react(text)` превращает ответ обратно в тот же `AssistantTurn`,
что и нативный путь, — цикл агента не различает провайдеров. Деградация мягкая: ответ без
разбираемого `Action` трактуется как финальный (плюс консервативная починка почти-JSON от
слабых моделей).

Бюджеты токенов (`config.yaml` → `token_budget`, на курс): `foreign: 50000`,
`russian: 30000`. Это **advisory**-страж: `budget_exceeded` лишь предупреждает (печать в CLI),
не прерывает анализ. Бюджет **шагов** чата — отдельный (`effort.py`: low=2 / medium=4 /
high=8 итераций).

---

## 8. Веб-слой

Существуют три ASGI-точки, по-разному собирающие один и тот же API:

| Модуль | Объект | Назначение |
|---|---|---|
| `web/serve.py` | `app` | **Продакшен**: отдаёт собранный SPA из `web/frontend/dist` + JSON-API в одном процессе. Запуск: `uvicorn web.serve:app` |
| `web/app.py` | `app` | **Legacy** Jinja-прототип v0.1: серверные страницы `/`, `/analyze`, `/history`, `/compare` + те же JSON-роуты (для разработки/совместимости). Запуск: `uvicorn web.app:app` |
| `web/api.py` | `build_router(...)` | Фабрика `APIRouter` с JSON/SSE-эндпоинтами; подключается и в `serve`, и в `app`. LLM-клиент и `rerun` инжектируются |

`web/serve.py` решает единственную коллизию SPA↔API на пути `GET /settings`:
браузерная навигация (`Accept: text/html`) к SPA-маршруту получает `index.html`; `fetch`/SSE
(`application/json` / `text/event-stream`) проходят в API. SPA-маршруты:
`/`, `/results`, `/history`, `/compare`, `/chat`, `/settings` (старый `/export` перенаправляется на `/results`).

### Ключевые эндпоинты (`build_router`)

| Метод и путь | Назначение |
|---|---|
| `POST /threads` | создать диалог |
| `GET /threads` | список диалогов |
| `GET /threads/{id}` | получить диалог |
| `PATCH /threads/{id}` | переименовать / сменить категорию / привязать контекст / `clear_messages` / `detach` |
| `DELETE /threads/{id}` | удалить диалог |
| `GET /settings` | UI-снимок настроек (резолв компонентов + статус ключей, без сырых секретов) |
| `PUT /settings` | сохранить оверлей (deep-merge, пустой `keys` не стирает сохранённые) |
| `POST /analyze` | запуск анализа из загрузок (multipart), один/несколько групповых файлов → один прогон |
| `GET /runs` | список прогонов (история) |
| `GET /runs/{id}` | один прогон |
| `POST /compare` | численный diff двух прогонов (`compute_diff`) |
| `POST /chat` | поток ответа агента (SSE) |
| `POST /chat/confirm` | подтвердить/отклонить отложенный `run_analysis` (SSE) |
| `POST /chat/{id}/stop` | кнопка «Стоп» (регистрирует отмену для активного стрима) |
| `POST /chat/{id}/uploads` | стейджинг файлов к диалогу (для последующего `run_analysis`) |

Скачивание отчётов — отдельный `download_router` (`web/app.py`, переиспользуется в `serve`):
`GET /download/{id}.json|.xlsx|.txt` (Excel/текст принимают `?sections=`; Cyrillic-имя файла
через RFC 5987).

### SSE-протокол чата

Контракт событий (`web/chat_sse.py` → `SSE_EVENTS`; формат кадра
`event: <name>\ndata: <json>\n\n`):

| Событие | Когда | Полезная нагрузка |
|---|---|---|
| `status` | перед каждым шагом модели | `{text}` («Думаю…») |
| `tool` | один вызов инструмента | `{name, summary}` (строка для «Хода рассуждений») |
| `card` | инструмент вернул карточку | `{card}` (`stats` / `list` / `compare` / `report`) |
| `token` | инкрементальный текст ответа | `{text}` (чанки) |
| `confirm` | гейтированный `run_analysis` ждёт подтверждения | `{name, arguments}` (без `done`) |
| `budget` | исчерпан бюджет шагов | `{used, total, hint}` |
| `stopped` | пользователь нажал «Стоп» | `{}` (без `done`) |
| `done` | завершение хода | `{blocks}` (упорядоченные блоки для рендера/персиста) |
| `error` | ошибка/финализация по сбоям инструментов | `{text}` (по-русски) |

`sse_frame` отвергает событие вне контракта (`ValueError`). Поток порождается
`agents.chat_agent.loop.stream_turn`, который, помимо `done`, отдаёт `tool_trace` для
персиста хода рассуждений.

### Чат-агент: цикл и инструменты

`run_turn` / `stream_turn` (`loop.py`) — ограниченный циклом по `step_budget(effort)`
tool-calling. Инструмент `run_analysis` гейтируется подтверждением (`confirm_tools`); при
паузе незагейтированные инструменты того же хода всё равно выполняются, их карточки не
теряются. После `_TOOL_ERROR_CAP` (3) ошибок инструментов ход финализируется с тем, что
уже собрано. Реестр инструментов строит `build_registry(root, active_run_id, rerun, uploads)`:

| Инструмент | Назначение |
|---|---|
| `list_runs` | список прошлых анализов (внутренний lookup, без карточки) |
| `load_run` | сводка одного анализа |
| `query_stats` | срезы `summary` / `critical` / `attempts` / `question` |
| `compare_runs` | сравнение двух прогонов |
| `run_analysis` | запуск анализа по приложенным файлам (требует подтверждения) |
| `list_tests` / `query_by_test` | разбивка по тестам |
| `list_groups` / `query_group_stats` | разбивка по группам (мультифайловый прогон) |
| `query_students` | слабейшие/сильнейшие/аномалии по студентам |
| `query_trends` | динамика по ≥2 прогонам |
| `query_question_errors` | типичные ошибки по вопросу |
| `generate_report` | готовый текстовый отчёт (через `render_text`) |

Все read-инструменты возвращают `{card, data}` или `{error}`; числа берутся из кода.

---

## 9. Конфигурация и секреты

### `config.yaml` (несекретные настройки)

```
model_group: foreign            # активная группа: foreign | russian
models:
  foreign:   {provider: openrouter, base_url, api_key_env: OPENROUTER_API_KEY,
              model: deepseek/deepseek-v4-flash, reasoning: false, max_tokens, temperature}
  russian:   {provider: gigachat, api_key_env: GIGACHAT_CREDENTIALS,
              scope_env: GIGACHAT_SCOPE, model: GigaChat, verify_ssl: false, max_tokens, temperature}
thresholds:  {critical_correct_rate, fast_factor, slow_factor, fuzzy_accept, min_samples}
paths:       {input, reference, output}
token_budget: {foreign: 50000, russian: 30000}
llm_batch_size: 1
```

Маппинг в типы — `core/config.py` (`AppConfig`, `ModelConfig`, `Thresholds`, `Paths`).

Пороги (`thresholds`), действующие значения из `config.yaml`:

| Ключ | Значение | Смысл |
|---|---|---|
| `critical_correct_rate` | `0.5` | вопрос «критический», если доля верных ниже |
| `fast_factor` | `0.3` | время < median·fast_factor → подозрение на подсмотр |
| `slow_factor` | `3.0` | время > median·slow_factor → подозрение на затруднение |
| `fuzzy_accept` | `0` | нечёткое авто-зачисление **выключено** (0); exact/number/set всегда включены |
| `min_samples` | `10` | минимум ответов, прежде чем вопрос можно пометить критическим |

> Примечание: дефолты Pydantic в `Thresholds` (`fuzzy_accept=92`) и
> `AppConfig.llm_batch_size=5` отличаются от значений в `config.yaml` (`0` и `1`). Источник
> истины — `config.yaml`; дефолты Pydantic применяются только если ключ в YAML отсутствует.

### `.env` (секреты)

В `config.yaml` секреты задаются **именем** переменной (`api_key_env`/`scope_env`), значение
читается из окружения. Переменные (`.env.example`): `OPENROUTER_API_KEY`,
`GIGACHAT_CREDENTIALS`, `GIGACHAT_SCOPE` (по умолчанию `GIGACHAT_API_PERS`); опционально
`YANDEX_API_KEY`, `YANDEX_FOLDER_ID`. `.env` — в `.gitignore`, ключи не коммитятся.

### Принцип «ничего не захардкожено» и порядок разрешения

`load_config` сливает `config.yaml` + `.env` и резолвит ключ активной группы; при
`require_key=True` отсутствие ключа даёт понятный русский `ConfigError`. UI может
переопределять выбор модели и (опционально) ключи: `core/settings.py` хранит оверлей в
`output/settings.json`. Порядок разрешения всегда **UI-оверлей > config.yaml > встроенный
дефолт** (`resolve_component`, `resolve_key`). Ключи из UI маскируются (`mask_secret`) и
никогда не пишутся в `config.yaml` или исходники; система полностью работает и от одного
`.env`. Базовый (код-только) анализ ключей не требует.

---

## 10. Детерминизм и воспроизводимость

- `temperature = 0.0` для обеих групп (`config.yaml`).
- `llm_batch_size: 1` — батчинг выключен. Батчинг **не нейтрален** к вердиктам (делает обе
  модели заметно строже; см. `benchmarks/strict/strict_results.md`), поэтому по умолчанию
  ответы судятся независимо.
- `AnswerCache` (`agents/answer_agent/cache.py`) — детерминированный ключ
  `sha256(model | normalised question | given | correct | PROMPT_VERSION)`; идентичные
  свободные ответы не пересчитываются (в т.ч. между прогонами и курсами). `PROMPT_VERSION`
  (`comparator.py`, сейчас `"2-strict"`) входит в ключ, поэтому смена промпта инвалидирует
  кэш.
- `pipeline.stats.question_stats` агрегирует по нормализованному тексту вопроса
  (`normalize_question`), порядок входа не влияет на результат (курсы сортируются по
  `course_id`, прогон каждого изолирован).
- Тесты воспроизводимости: `tests/test_reproducibility.py` (движок байт-в-байт стабилен и
  не зависит от порядка входа) и `tests/test_golden_069.py` против золотой фикстуры
  `tests/golden/report_069.json` (регенерация — `tests/regen_golden.py`).

---

## 11. Тестирование

### Backend (pytest)

```
pytest                       # весь набор (pytest.ini: pythonpath=., testpaths=tests, -q)
pytest tests/test_runner.py  # отдельный модуль
pytest -k chat               # по подстроке
```

В `tests/` — около 348 тест-функций в 54 файлах (с параметризацией фактический счёт
прогона выше, ориентир ~355 проходящих). Покрытие включает: парсеры (`test_data_loader`,
`test_json_csv_parsers`, `test_excel_utils`), агент ответов и сопоставление
(`test_answer_agent`, `test_comparator`, `test_reference_match`, `test_pattern_detector`,
`test_cache`), агент времени (`test_time_agent`), отчёты (`test_report_generator`,
`test_excel_report`), insight (`test_insight_agent`, `test_compare_diff`), адаптеры и
протокол (`test_openrouter_*`, `test_gigachat_*`, `test_react_protocol`,
`test_parity_native_vs_react`, `test_tool_client_factory`, `test_protocol_contract`),
чат-цикл и инструменты (`test_chat_loop`, `test_chat_tools`, `test_chat_tools_compare`,
`test_chat_sse*`, `test_chat_threads`, `test_chat_effort`), HTTP-слой (`test_api_chat*`,
`test_api_settings`, `test_api_tabs`, `test_api_threads`, `test_api_coexist`,
`test_web_service`, `test_app_rerun`), конфиг/настройки (`test_config_*`, `test_settings*`),
воспроизводимость и золотую фикстуру.

Фейки для HTTP/чата без реального провайдера — `tests/chat_fakes.py`
(`FakeToolCallingClient`); вспомогательные скрипты — `tests/check_*.py`,
`tests/compare_groups.py`, `tests/estimate_cost.py`.

### Frontend (vitest)

```
cd web/frontend
npm install        # один раз
npm run test       # vitest run
npm run typecheck  # tsc --noEmit
```

Тесты лежат рядом с компонентами (`*.test.ts(x)`): экраны (`screens/*.test.tsx`), карточки
и блоки чата (`components/**/**.test.tsx`), API-клиент и SSE (`api/*.test.ts`), типы
(`types/chat.test.ts`); общий setup — `src/test/setup.ts`.

---

## 12. Точки расширения

### Новая модель/провайдер

1. Добавить группу в `config.yaml` (`provider`, `model`, `api_key_env`, при необходимости
   `base_url`/`scope_env`/`verify_ssl`).
2. Реализовать адаптер(ы) в `models/<group>/`: класс с методом `complete(system, user) ->
   LLMResult` (для анализа/insight) и/или `chat(messages, tools) -> AssistantTurn` (для
   чата). Для провайдера без нативного function-calling переиспользовать
   `models/react.py` (`build_react_system` + `parse_react`), как `GigaChatReActClient`.
3. Зарегистрировать провайдер в `get_client` и `build_tool_client` (`models/__init__.py`)
   по `mc.provider`.
4. Добавить имена ключей в `core/settings.py` (`KEY_ENV_NAMES`), если их должен принимать UI.

### Новый формат входа

1. Написать парсер с теми же сигнатурами, что у существующих:
   `parse_<fmt>_answers(filepath, course_id) -> list[StudentAttempt]` и
   `parse_<fmt>_reference(filepath) -> dict[str, dict[str, ReferenceAnswer]]` в
   `pipeline/parsers/`.
2. Добавить расширение в `_SUPPORTED_SUFFIXES` и ветку диспетчера `_parse_answers` /
   `_parse_ref` в `pipeline/data_loader.py` (JSON/CSV-парсеры бросают `ValueError`,
   нормализуемый в `ParseError` через `_as_parse_error`).
3. Покрыть тестом по образцу `tests/test_json_csv_parsers.py`.

### Новый инструмент чат-агента

1. Написать функцию `my_tool(...) -> {"card": ..., "data": ...} | {"error": ...}` в
   `agents/chat_agent/tools.py` (числа — из кода, не из LLM).
2. Добавить JSON-schema в `_SCHEMAS` и lambda-обёртку в `build_registry` (`run_id` обычно
   подставляется из активного контекста через `_rid`).
3. При необходимости подтверждения добавить имя в `confirm_tools` цикла. Тип карточки
   переиспользовать из существующих (`stats`/`list`/`compare`/`report`), иначе понадобится
   правка фронтенда (`components/cards/`).

### Новый блок ИИ-выводов

1. Добавить ключ в `BLOCK_KEYS` и подпись в `BLOCK_TITLES` (`agents/insight_agent/options.py`).
2. Реализовать генерацию блока в `agents/insight_agent/commentary.py` и при необходимости
   промпт в `agents/insight_agent/prompts/commentary.yaml`.
3. Отразить подпись в текстовом рендере (`report_agent/generator.render_text`) и UI.

---

## 13. Запуск (кратко)

### CLI

```
python main.py --input ./data/samples/021 --reference ./data/etalon/021 --mode all
python main.py --input ./data/samples/001 --reference ./data/etalon/001 \
               --mode answer --max-llm-calls 20 --model-group foreign
```

Флаги: `--input` (обяз.), `--reference`, `--output` (по умолчанию `./output`),
`--mode {answer,time,report,all}`, `--model-group {foreign,russian}`, `--model` (разовая
замена slug), `--max-llm-calls N` (0 = без LLM, только код), `--insights`
(`diagnosis,why_failed,recommendations,anomalies`), `--insight-note`.

### Веб

- **Продакшен** (один процесс, без Node): `uvicorn web.serve:app` — отдаёт собранный SPA
  (`web/frontend/dist`) + JSON-API. Или одним кликом: `START.bat` (Windows) / `./start.sh`
  (Unix) → `scripts/launch.py` (создаёт `.venv`, ставит зависимости, поднимает сервер на
  свободном порту, начиная с 8010, и открывает браузер).
- **Разработка**: backend `uvicorn web.app:app --reload` + frontend `cd web/frontend &&
  npm run dev` (Vite на :5173 проксирует API на backend).

Базовый анализ работает офлайн без ключей; ключи нужны только для ИИ-комментариев и чата.
Детали запуска и установки — в `docs/run_guide.md`.

---

## Куда смотреть дальше

- `docs/QUICKSTART.md` — краткий старт для методиста (одна страница).
- `docs/user_guide.md` — руководство пользователя (методиста).
- `docs/run_guide.md` — запуск и установка (веб + CLI), решение типовых проблем.
- `docs/admin_guide.md` — администрирование, ключи, окружение.
- `docs/input_formats.md` — форматы входных файлов (.xlsx/.json/.csv) и их особенности.
- `README.md` — обзор проекта и быстрый старт.
