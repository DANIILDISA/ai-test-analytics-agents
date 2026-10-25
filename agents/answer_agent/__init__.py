"""Agent 1 — Answer Comparison (**current sprint**).

Consumes parsed ``core.models.StudentAttempt`` records (from
``pipeline.parsers.answer_array_parser``) and the ``core.models.ReferenceAnswer``
key (from ``pipeline.parsers.reference_parser``), compares each answer against
the reference, scores similarity, and surfaces questions with mass wrong answers.

Choice / ranking / matching are already graded by the LMS (``result_code``) and
must NOT be re-graded or sent to an LLM -- the LLM is used only for free-text and
numeric answers (``QuestionType.needs_semantic_check``).

Modules:
* ``comparator``       — compare given vs. reference answers (LLM).
* ``scorer``           — deterministic similarity fallback.
* ``pattern_detector`` — critical-question + common-error detection.

Public entry point: :func:`analyze`.
"""

from __future__ import annotations

import logging
from collections import Counter, OrderedDict
from datetime import datetime, timezone

from agents.answer_agent.cache import AnswerCache
from agents.answer_agent.comparator import PROMPT_VERSION, review_answer, review_answers_batch
from agents.answer_agent.reference_match import match_acceptable
from agents.answer_agent.pattern_detector import common_errors, is_critical
from core.models import PARTIAL_CREDIT
from pipeline.parsers.excel_utils import normalize_question
from pipeline.stats import course_summary, question_stats
from models.base import LLMResult

log = logging.getLogger("korpus.answer_agent")

#: A «wrong» answer picked by at least this share of respondents hints at an error in the key.
_KEY_SUSPECT_SHARE = 0.6

#: After this many consecutive failed LLM calls the rest of the course goes code-only.
_MAX_CONSECUTIVE_LLM_FAILURES = 3


def analyze(
    course,
    client=None,
    *,
    critical_rate: float = 0.5,
    max_llm_calls: int = 0,
    fuzzy_threshold: int = 92,
    llm_batch_size: int = 1,
    min_samples: int = 10,
    top_errors: int = 3,
    cache: AnswerCache | None = None,
) -> dict:
    """Run Agent 1 over one course. LLM calls happen only if ``client`` is given
    and ``max_llm_calls > 0`` (budget guard); identical free-text judgements are
    deduplicated and served from ``cache`` (persistent if it has a path).
    When ``llm_batch_size > 1`` several answers are judged per call, so
    ``max_llm_calls`` caps the number of LLM **calls**, not individual answers."""
    # Guard against silent misconfig that would corrupt the whole run: e.g.
    # critical_rate=50 (meant 0.5) makes every question non-critical,
    # min_samples<=0 flags everything, fuzzy_threshold outside 0..100 disables
    # fuzzy matching. Fail loudly with an actionable Russian message instead.
    if not 0 <= critical_rate <= 1:
        raise ValueError(
            f"critical_rate должен быть в диапазоне 0..1 (доля), получено: {critical_rate}"
        )
    if min_samples < 1:
        raise ValueError(
            f"min_samples должен быть >= 1, получено: {min_samples}"
        )
    if not 0 <= fuzzy_threshold <= 100:
        raise ValueError(
            f"fuzzy_threshold должен быть в диапазоне 0..100, получено: {fuzzy_threshold}"
        )

    qstats = question_stats(course.attempts)
    summary = course_summary(course.attempts, total_questions=len(qstats))

    usage = {
        "calls": 0, "cache_hits": 0, "auto_matched": 0,
        "prompt_tokens": 0, "completion_tokens": 0, "reasoning_tokens": 0, "cost": 0.0,
    }
    failed_calls = 0
    llm_failures = 0  # consecutive
    llm_errors: list[str] = []
    cache = cache or AnswerCache(None)  # in-memory fallback dedups within the run
    questions_out: list[dict] = []

    for qs in qstats:
        q: dict = {
            "question_id": qs.question_id,
            "test_name": qs.test_name,
            "question_text": qs.question_text,
            "type": qs.qtype.value,
            "answered": qs.answered,
            "correct": qs.correct,
            "wrong": qs.wrong,
            **({"partial": qs.partial} if qs.partial else {}),
            "correct_rate": qs.correct_rate,
            "critical": is_critical(qs, critical_rate=critical_rate, min_samples=min_samples),
            "common_errors": common_errors(qs, top_errors),
            "llm_reviewed": False,
        }
        if qs.correct_sample:
            q["correct_answer"] = qs.correct_sample

        if qs.qtype.needs_semantic_check and qs.wrong:
            normq = normalize_question(qs.question_text)
            ref = course.reference.get(qs.test_name, {}).get(normq)
            if ref is None and qs.test_name not in course.reference:
                # The sheet was renamed in one of the files: link by question text alone.
                for book in course.reference.values():
                    ref = book.get(normq)
                    if ref is not None:
                        break
            acceptable = ref.acceptable if ref else []
            correct_sample = (ref.raw_answer if ref else "") or qs.correct_sample
            if correct_sample:
                q["correct_answer"] = correct_sample
            auto: list[dict] = []
            reviews: list[dict] = []
            pending: list[tuple[str, int, str]] = []
            # Phase 1 — classify each distinct wrong answer (zero-token).
            for given, cnt in qs.wrong_answers.most_common():
                if not given:
                    continue
                m = match_acceptable(given, acceptable, correct_sample, threshold=fuzzy_threshold)
                if m is not None:
                    auto.append({"given": given, "count": cnt, "match_type": m.kind, "matched": m.variant})
                    usage["auto_matched"] += 1
                    continue
                if client is None or max_llm_calls <= 0:
                    continue
                ckey = cache.make_key(
                    model=client.name, question=normq, given=given,
                    correct=correct_sample, prompt_version=PROMPT_VERSION,
                )
                cached = cache.get(ckey)
                if cached is not None:
                    usage["cache_hits"] += 1
                    reviews.append({"given": given, "count": cnt, **cached})
                else:
                    pending.append((given, cnt, ckey))
            # Phase 2 — judge cache-misses via the LLM, packing several per call.
            batch = max(1, llm_batch_size)
            i = 0
            while i < len(pending) and usage["calls"] < max_llm_calls:
                chunk = pending[i:i + batch]
                i += len(chunk)
                try:
                    if llm_failures >= _MAX_CONSECUTIVE_LLM_FAILURES:
                        raise _LLMSkipped()
                    if batch == 1:
                        verdict, res = review_answer(
                            client, question=qs.question_text, given=chunk[0][0],
                            correct=correct_sample, acceptable=acceptable,
                        )
                        chunk_verdicts = [verdict]
                    else:
                        chunk_verdicts, res = review_answers_batch(
                            client, question=qs.question_text,
                            givens=[g for g, _, _ in chunk],
                            correct=correct_sample, acceptable=acceptable,
                        )
                    llm_failures = 0
                except _LLMSkipped:
                    chunk_verdicts = [_unavailable() for _ in chunk]
                    res = LLMResult(text="", prompt_tokens=0, completion_tokens=0, cost=0.0)
                except Exception as exc:  # noqa: BLE001 - one failed item must not abort the course
                    if getattr(exc, "status_code", None) == 401:
                        raise
                    llm_failures += 1
                    failed_calls += 1
                    msg = f"{exc.__class__.__name__}: {exc}"[:200]
                    if len(llm_errors) < 3:
                        llm_errors.append(msg)
                    log.warning("LLM недоступен для вопроса %s: %s", qs.question_id, msg)
                    chunk_verdicts = [_unavailable() for _ in chunk]
                    res = LLMResult(text="", prompt_tokens=0, completion_tokens=0, cost=0.0)
                    usage["calls"] += 1
                else:
                    usage["calls"] += 1
                usage["prompt_tokens"] += res.prompt_tokens
                usage["completion_tokens"] += res.completion_tokens
                usage["reasoning_tokens"] += res.reasoning_tokens
                usage["cost"] += res.cost
                stored = False
                for (given, cnt, ckey), verdict in zip(chunk, chunk_verdicts):
                    if not verdict.pop("uncached", False):
                        cache.set(ckey, verdict)
                        stored = True
                    reviews.append({"given": given, "count": cnt, **verdict})
                if stored:
                    cache.save()  # flush per call: paid-for verdicts survive a later crash
            if auto:
                q["auto_matched"] = auto
                q["auto_false_negatives"] = len(auto)
            if reviews:
                q["llm_reviewed"] = True
                q["llm_reviews"] = reviews
                q["llm_false_negatives"] = sum(1 for r in reviews if r["acceptable"])
        questions_out.append(q)

    # Collapse the same question across the course's several tests (sheets) into ONE row,
    # so it isn't listed (and counted as critical) once per test (R2-8). total_questions
    # becomes the count of UNIQUE questions.
    questions_out = _merge_questions_by_text(
        questions_out, critical_rate=critical_rate, min_samples=min_samples
    )
    summary["total_questions"] = len(questions_out)

    usage["cost"] = round(usage["cost"], 6)
    if failed_calls:
        usage["failed_calls"] = failed_calls
    return {
        "course_id": course.course_id,
        "analyzed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "summary": summary,
        "questions": questions_out,
        "llm_usage": usage,
        "warnings": list(course.warnings) + list(getattr(course, "notes", [])) + (
            [
                f"ИИ был недоступен для {failed_calls} вызовов (итог по этим ответам - "
                f"только по коду; кэш сохранён): {llm_errors[0]}"
            ] if failed_calls else []
        ),
    }


class _LLMSkipped(Exception):
    pass


def _unavailable() -> dict:
    return {"acceptable": False, "reason": "(LLM недоступен)", "uncached": True}


def _merge_questions_by_text(
    questions: list[dict], *, critical_rate: float, min_samples: int
) -> list[dict]:
    """Collapse per-(test, question) rows into one row per unique question TEXT, summing
    answered/correct/wrong and common errors across the tests it appears in. ``tests`` lists
    those tests; ``correct_rate`` and ``critical`` are recomputed on the pooled counts (R2-8)."""
    merged: "OrderedDict[str, dict]" = OrderedDict()
    errors: dict[str, Counter] = {}
    extra: dict[str, dict] = {}
    for q in questions:
        key = normalize_question(q.get("question_text", "") or "")
        m = merged.get(key)
        if m is None:
            m = {
                "question_id": q.get("question_id"),
                "test_name": q.get("test_name"),
                "tests": [],
                "question_text": q.get("question_text"),
                "type": q.get("type"),
                "answered": 0,
                "correct": 0,
                "wrong": 0,
                "partial": 0,
                "llm_reviewed": False,
            }
            if q.get("correct_answer"):
                m["correct_answer"] = q["correct_answer"]
            merged[key] = m
            errors[key] = Counter()
            extra[key] = {"llm_reviews": [], "auto_matched": [], "llm_fn": 0, "auto_fn": 0}
        if q.get("correct_answer") and not m.get("correct_answer"):
            m["correct_answer"] = q["correct_answer"]
        tn = q.get("test_name")
        if tn and tn not in m["tests"]:
            m["tests"].append(tn)
        m["answered"] += int(q.get("answered") or 0)
        m["correct"] += int(q.get("correct") or 0)
        m["wrong"] += int(q.get("wrong") or 0)
        m["partial"] += int(q.get("partial") or 0)
        m["llm_reviewed"] = m["llm_reviewed"] or bool(q.get("llm_reviewed"))
        for e in q.get("common_errors") or []:
            ans = e.get("answer")
            if ans:
                errors[key][ans] += int(e.get("count") or 0)
        ex = extra[key]
        ex["llm_reviews"].extend(q.get("llm_reviews") or [])
        ex["auto_matched"].extend(q.get("auto_matched") or [])
        ex["llm_fn"] += int(q.get("llm_false_negatives") or 0)
        ex["auto_fn"] += int(q.get("auto_false_negatives") or 0)

    out: list[dict] = []
    for key, m in merged.items():
        answered = m["answered"]
        earned = m["correct"] + PARTIAL_CREDIT * m["partial"]
        m["correct_rate"] = round(earned / answered, 4) if answered else 0.0
        if not m["partial"]:
            del m["partial"]
        m["critical"] = answered >= min_samples and m["correct_rate"] < critical_rate
        m["common_errors"] = [
            {"answer": a, "count": c} for a, c in errors[key].most_common(3)
        ]
        # A single «wrong» answer chosen by most people is the classic sign of a wrong key.
        if m["common_errors"] and answered >= min_samples:
            top = m["common_errors"][0]
            share = top["count"] / answered if answered else 0.0
            if share >= _KEY_SUSPECT_SHARE:
                m["key_suspect"] = {"answer": top["answer"], "share": round(share, 4)}
        ex = extra[key]
        if ex["llm_reviews"]:
            m["llm_reviews"] = ex["llm_reviews"]
            m["llm_false_negatives"] = ex["llm_fn"]
        if ex["auto_matched"]:
            m["auto_matched"] = ex["auto_matched"]
            m["auto_false_negatives"] = ex["auto_fn"]
        out.append(m)
    return out
