"""CLI entry point for TestAnalyzer (Phase 1, console).

Usage:
    python main.py --input ./data/samples/021 --reference ./data/etalon/021 --output ./output
    python main.py --input ./data/samples/001 --reference ./data/etalon/001 --mode answer --max-llm-calls 20

LLM calls happen only when ``--max-llm-calls > 0`` (default 0 = free, code-only run).
All model/key/path settings come from config.yaml + .env — nothing is hardcoded.
"""

from __future__ import annotations

import argparse
import sys


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Анализ результатов тестовых заданий (TestAnalyzer)"
    )
    parser.add_argument("--input", required=True, help="Файл или папка с ответами пользователей (Массив)")
    parser.add_argument("--reference", help="Файл или папка с эталонными ответами (Эталон)")
    parser.add_argument("--output", default="./output", help="Папка для отчётов")
    parser.add_argument(
        "--mode", choices=["answer", "time", "report", "all"], default="all",
        help="Какие модули запускать (report = answer+time, затем отчёт)",
    )
    parser.add_argument("--model-group", help="Группа нейросетей (foreign|russian); по умолчанию из config.yaml")
    parser.add_argument("--model", help="Разовая замена модели из config.yaml (slug)")
    parser.add_argument(
        "--max-llm-calls", type=int, default=0,
        help="Максимум обращений к LLM на курс (0 = без LLM, только код)",
    )
    parser.add_argument(
        "--insights", default="",
        help="ИИ-выводы по отчёту: список разделов через запятую "
             "(diagnosis,why_failed,recommendations,anomalies). Дёшево (1 вызов на курс).",
    )
    parser.add_argument("--insight-note", default="", help="Свободное пожелание к ИИ-выводам")
    return parser


def main() -> int:
    args = build_parser().parse_args()

    from core.config import ConfigError, load_config
    from pipeline.data_loader import load
    from pipeline.runner import RunOptions, budget_exceeded, run_all, usage_total_tokens
    from agents.report_agent.generator import write_reports

    need_answer = args.mode in ("answer", "all", "report")
    need_time = args.mode in ("time", "all", "report")
    modes = set()
    if need_answer:
        modes.add("answer")
    if need_time:
        modes.add("time")

    from agents.insight_agent import InsightOptions

    insight_blocks = [b.strip() for b in args.insights.split(",") if b.strip()]
    insight_options = InsightOptions.from_list(insight_blocks, custom=args.insight_note, enabled=True)
    use_insights = insight_options.active

    use_llm = need_answer and args.max_llm_calls > 0
    need_client = use_llm or use_insights
    try:
        cfg = load_config(model_group=args.model_group, require_key=need_client)
    except ConfigError as exc:
        print(f"ОШИБКА КОНФИГУРАЦИИ: {exc}")
        return 2
    if args.model:
        cfg.active_model.model = args.model

    client = None
    if need_client:
        from models import get_client
        client = get_client(cfg)
        if use_llm:
            print(f"Модель: {client.name}  (лимит вызовов на курс: {args.max_llm_calls})")
        else:
            print(f"Модель: {client.name}  (только ИИ-выводы по агрегатам)")
    else:
        print("Режим без LLM (только код, 0 токенов).")

    cache = None
    if use_llm:
        from pathlib import Path
        from agents.answer_agent.cache import AnswerCache
        cache = AnswerCache(Path(args.output) / ".cache" / "answer_cache.json")

    try:
        courses = load(args.input, args.reference)
    except Exception as exc:
        print(f"ОШИБКА ЗАГРУЗКИ ДАННЫХ: {exc}")
        return 1
    if not courses:
        print("Не найдено входных файлов (.xlsx) по указанному пути.")
        return 1

    if client is not None:
        from models.scrubbing import learn
        for course in courses:
            learn(client, course=course)

    # Validation gate: refuse to run on incorrect/incomplete input with a clear
    # Russian explanation instead of failing later with a generic error.
    invalid = False
    for course in courses:
        problems = course.validate()
        if problems:
            invalid = True
            print(f"НЕКОРРЕКТНЫЕ ВХОДНЫЕ ДАННЫЕ (курс {course.course_id}):", file=sys.stderr)
            for p in problems:
                print(f"  - {p}", file=sys.stderr)
    if invalid:
        return 1

    options = RunOptions(modes=modes, max_llm_calls=args.max_llm_calls)
    budget = cfg.token_budget.get(cfg.model_group)  # advisory per-course token cap (may be None)
    written: list = []
    total_cost = 0.0
    total_tokens = 0
    failures = 0
    # run_all isolates per-course failures and saves the cache after each course.
    for course, result, error in run_all(courses, cfg, client, options, cache=cache):
        if error is not None:
            failures += 1
            print(f"  курс {course.course_id}: ОШИБКА АНАЛИЗА — {error} (курс пропущен)")
            continue

        if use_insights:
            from agents.insight_agent import comment, suggest_inputs
            result["insights"] = {
                "commentary": comment(result, insight_options, client),
                "suggestions": suggest_inputs(
                    course, result, min_samples=cfg.thresholds.min_samples, client=client
                ),
            }

        paths = write_reports(result, args.output, course_id=course.course_id)
        written.extend(paths)

        a1 = result.get("answer", {})
        s = a1.get("summary", {})
        u = a1.get("llm_usage", {})
        toks = usage_total_tokens(u)
        total_cost += u.get("cost", 0.0)
        total_tokens += toks
        crit = sum(1 for q in a1.get("questions", []) if q.get("critical"))
        print(
            f"  курс {course.course_id}: попыток(реал) {s.get('real_attempts', '-')}, "
            f"вопросов {s.get('total_questions', '-')}, критических {crit}, "
            f"LLM-вызовов {u.get('calls', 0)} (кэш: {u.get('cache_hits', 0)}), "
            f"токенов {toks} (${u.get('cost', 0.0)})"
        )
        if budget_exceeded(u, budget):
            print(
                f"    ВНИМАНИЕ: превышен бюджет токенов: {toks} > {budget} "
                f"(группа {cfg.model_group}). Уменьшите объём или включите батчинг (llm_batch_size)."
            )
        if course.warnings:
            print(f"    предупреждений: {len(course.warnings)}")
            for w in course.warnings:
                print(f"      - {w}")

    if cache is not None:
        cache.save()  # safety net; run_all already saved incrementally
    if failures:
        print(f"\nВНИМАНИЕ: курсов с ошибкой: {failures} (остальные обработаны).")
    print(
        f"\nГотово. Суммарно: токенов {total_tokens}, стоимость LLM ${round(total_cost, 6)}. Отчёты:"
    )
    for p in written:
        print(f"  {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
