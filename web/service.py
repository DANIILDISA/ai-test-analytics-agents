"""Glue between browser uploads and the existing pipeline + AI insight layer.

The pipeline is path-based: ``data_loader.load`` discovers courses by folder name and
classifies files by name (``массив`` / ``эталон``). The web layer's job is to stage the
uploaded files into that shape, run the *same* runner the CLI uses, then (optionally) run
Agent 4 (insights) over the aggregated result and persist the run to history. No analysis
logic lives here — this is plumbing only.
"""

from __future__ import annotations

import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

from agents.insight_agent import InsightOptions, comment, suggest_inputs
from core import history
from pipeline.file_roles import fix_mojibake

_CACHE_PATH = Path("output") / ".cache" / "answer_cache.json"


@dataclass
class Upload:
    """One uploaded file, held in memory (filename is kept for extension + group hints)."""

    filename: str
    data: bytes


def _restore_names(text: str, shown: dict[str, str]) -> str:
    for staged, original in shown.items():
        text = text.replace(staged, original)
    return text


def modes_from(mode: str) -> set[str]:
    """Map the UI's single ``mode`` choice to the runner's mode set."""
    if mode == "answer":
        return {"answer"}
    if mode == "time":
        return {"time"}
    return {"answer", "time"}  # "all" / "report"


def _group_label(filename: str, index: int) -> str:
    """Human label for a group, parsed from its file name ('…группа 2.xlsx' → 'Группа 2')."""
    filename = fix_mojibake(filename)
    m = re.search(r"(?<![a-zа-яё])(?:групп[аеноуы]*|group|gr)\s*[_\-]?\s*(\d+)", filename, re.IGNORECASE)
    if m:
        return f"Группа {m.group(1)}"
    return f"Группа {index + 1}"


def _group_labels(filenames: list[str]) -> list[str]:
    """Labels for several group files: the number from the file name when it has one,
    otherwise the first number nobody else uses (so two groups never share a label)."""
    explicit: list[int | None] = []
    for fn in filenames:
        m = re.search(r"(\d+)\s*$", _group_label(fn, -1)) if re.search(
            r"(?<![a-zа-яё])(?:групп[аеноуы]*|group|gr)\s*[_\-]?\s*\d+", fix_mojibake(fn), re.IGNORECASE
        ) else None
        explicit.append(int(m.group(1)) if m else None)
    used = {n for n in explicit if n is not None}
    seen: set[int] = set()
    out: list[str] = []
    nxt = 1
    for n in explicit:
        if n is not None and n not in seen:
            seen.add(n)
            out.append(f"Группа {n}")
            continue
        while nxt in used or nxt in seen:
            nxt += 1
        seen.add(nxt)
        used.add(nxt)
        out.append(f"Группа {nxt}")
    return out


_DEFAULT_COURSE = "анализ"
_SUPPORTED_SUFFIXES = (".xlsx", ".csv", ".json")
_YEAR_RE = re.compile(r"^(19|20)\d\d$")
_NUM_RE = re.compile(r"(?<![\d.])(\d{2,4})(?!\d)")


def _derive_course_id(uploads: list[Upload], reference: Upload | None) -> str:
    """Course label for a run, taken from the file names («… ЭК 069_группа 1.xlsx» → «ЭК 069»).

    Falls back to the default «анализ» when no file name carries a course number."""
    names = [u.filename for u in uploads] + ([reference.filename] if reference else [])
    for name in names:
        stem = Path(fix_mojibake(name)).stem
        stem = re.sub(r"(?:групп[аеноуы]*|group|gr)\s*[_\-]?\s*\d+", "", stem, flags=re.IGNORECASE)
        for m in _NUM_RE.finditer(stem):
            if not _YEAR_RE.match(m.group(1)):
                return f"ЭК {m.group(1)}"
    return _DEFAULT_COURSE


def plural_ru(n: int, one: str, few: str, many: str) -> str:
    """Russian plural form for a count: 1 группа / 2 группы / 5 групп."""
    n = abs(int(n))
    if n % 100 in (11, 12, 13, 14):
        return many
    return one if n % 10 == 1 else few if n % 10 in (2, 3, 4) else many


def _groups_phrase(labels: list[str]) -> str:
    """«группа 2», «группы 1–4» or «группы 1, 3, 5» from labels like «Группа 3»."""
    nums = []
    for lb in labels:
        m = re.search(r"(\d+)\s*$", lb)
        if m:
            nums.append(int(m.group(1)))
    if not nums or len(nums) != len(labels):
        return f"{len(labels)} {plural_ru(len(labels), 'группа', 'группы', 'групп')}"
    nums = sorted(set(nums))
    word = "группа" if len(nums) == 1 else "группы"
    if len(nums) > 2 and nums[-1] - nums[0] == len(nums) - 1:
        return f"{word} {nums[0]}–{nums[-1]}"
    return f"{word} {', '.join(str(n) for n in nums)}"


def _run_name(uploads: list[Upload], course_id: str = _DEFAULT_COURSE, labels: list[str] | None = None) -> str:
    """Default run title: «ЭК 069, группы 1–4, 10.10.2026 00:40»; without a detectable
    course the first file's name (or the multi-group «<test> (N групп)» form) is used.
    ``labels`` are the group labels to mention (None / empty ⇒ no group part)."""
    import time as _time

    if course_id and course_id != _DEFAULT_COURSE:
        parts = [course_id]
        if labels:
            parts.append(_groups_phrase(labels))
        parts.append(_time.strftime("%d.%m.%Y %H:%M"))
        return ", ".join(parts)
    if len(uploads) == 1:
        return fix_mojibake(uploads[0].filename)
    base = re.sub(
        r"[_\-\s]*групп[аеноуы]*\s*[_\-]?\s*\d+", "", Path(uploads[0].filename).stem, flags=re.IGNORECASE
    ).strip(" _-")
    n = len(uploads)
    return f"{base or 'Анализ'} ({n} {plural_ru(n, 'группа', 'группы', 'групп')})"


def _note_missing_group(skipped: list[dict], up: Upload, label: str) -> None:
    """Record a group file that produced no usable data (unless a loader warning already names it)."""
    name = fix_mojibake(up.filename)
    if any(d["file"] == name for d in skipped):
        return
    skipped.append({"file": name, "reason": f"{label}: в файле не найдено данных для анализа"})


def _input_report(
    uploads: list[Upload],
    all_uploads: list[Upload],
    reference: Upload | None,
    skipped: list[dict],
    groups: list[dict],
    course,
    limitations: list[str],
) -> dict:
    """Structured «what we understood in your files» block shown next to the results."""
    answer_files = len(all_uploads)
    ref_name = fix_mojibake(reference.filename) if reference else None
    skipped_names = {d["file"] for d in skipped}
    skipped_answers = [d for d in skipped if d["file"] != ref_name]
    return {
        "answer_files": answer_files,
        "answer_files_used": max(0, answer_files - len(skipped_answers)),
        "groups_total": len(uploads) if len(uploads) > 1 else 0,
        "groups_used": len(groups) if len(uploads) > 1 else 0,
        "has_reference": reference is not None,
        "reference_name": ref_name,
        "skipped": skipped,
        "skipped_names": sorted(skipped_names),
        "notes": list(dict.fromkeys(course.notes)),
        "limitations": limitations,
    }


def run_analysis(
    answers: Upload | list[Upload],
    reference: Upload | None,
    *,
    course_id: str = "анализ",
    model_group: str | None = None,
    mode: str = "all",
    max_llm_calls: int = 0,
    insight_options: InsightOptions | None = None,
    save: bool = True,
    history_root: Path | str | None = None,
) -> dict:
    """Stage the uploads, run the selected agents + insights, persist, return the result.

    ``answers`` is one upload or several group files. Multiple files become ONE run with
    a per-group breakdown: the top-level result is the COMBINED view (all students pooled,
    plus insights), and ``result["groups"]`` holds one ``{label, name, answer, time}`` per
    file (the same code-graded stats, sliced per group). Grading judgments are shared via
    the on-disk cache, so the per-group passes add ~no LLM cost.

    Free (code-only) when ``max_llm_calls == 0`` and no insights are requested. A client
    is built when *either* per-answer deep analysis *or* the (cheap) insight commentary
    is active. Returns the runner's result dict enriched with ``warnings``, ``groups``,
    ``insights``, and (when ``save``) a ``run_id``; on a per-course failure returns
    ``{"error": ...}``.

    ``history_root`` overrides where a saved run is persisted (default ``output/history``);
    the HTTP layer injects it so the same root powers ``/runs`` and ``/compare`` in tests.
    """
    from core.config import load_config
    from pipeline.data_loader import load
    from pipeline.runner import RunOptions, run_all

    all_uploads = answers if isinstance(answers, list) else [answers]
    if not course_id or course_id.strip().lower() == _DEFAULT_COURSE:
        course_id = _derive_course_id(all_uploads, reference)
    # Files of an unsupported type are never staged: they are reported as skipped instead
    # of being silently swallowed (or aborting the run).
    uploads = [u for u in all_uploads if Path(u.filename).suffix.lower() in _SUPPORTED_SUFFIXES]
    skipped: list[dict] = [
        {"file": fix_mojibake(u.filename), "reason": "формат не поддерживается (нужен .xlsx или .csv)"}
        for u in all_uploads if u not in uploads
    ]
    insight_options = insight_options or InsightOptions()
    modes = modes_from(mode)
    use_deep = "answer" in modes and max_llm_calls > 0
    use_insights = insight_options.active
    need_client = use_deep or use_insights

    cfg = load_config(model_group=model_group, require_key=need_client)

    client = None
    cache = None
    if need_client:
        from models import get_client

        client = get_client(cfg)
    if use_deep:
        from agents.answer_agent.cache import AnswerCache

        cache = AnswerCache(_CACHE_PATH)  # reuse the on-disk cache so re-runs are cheap

    options = RunOptions(modes=modes, max_llm_calls=max_llm_calls)

    with tempfile.TemporaryDirectory(prefix="testanalyzer_") as tmp:

        def stage_and_run(group_uploads: list[Upload], sub: str):
            """Stage these massiv files + the shared etalon under ``tmp/sub`` and run them
            as one course. Returns the runner's ``(course, result, error)`` tuple (or None)."""
            cdir = Path(tmp) / sub / course_id
            cdir.mkdir(parents=True, exist_ok=True)
            shown: dict[str, str] = {}  # staged name -> the name the user knows
            for i, up in enumerate(group_uploads):
                suffix = Path(up.filename).suffix or ".xlsx"
                (cdir / f"массив_{i}{suffix}").write_bytes(up.data)
                shown[f"массив_{i}{suffix}"] = fix_mojibake(up.filename)
            if reference is not None:
                ref_suffix = Path(reference.filename).suffix or ".xlsx"
                (cdir / f"эталон{ref_suffix}").write_bytes(reference.data)
                shown[f"эталон{ref_suffix}"] = fix_mojibake(reference.filename)
            courses = load(Path(tmp) / sub)
            if not courses:
                return None
            for c in courses:  # messages must name the user's files, not our staging names
                c.warnings[:] = [_restore_names(w, shown) for w in c.warnings]
                c.notes[:] = [_restore_names(n, shown) for n in c.notes]
            for c in courses:
                for sk in c.skipped:  # corrupted / unreadable files, named as the user knows them
                    sk["file"] = _restore_names(sk["file"], shown)
                    sk["reason"] = _restore_names(sk["reason"], shown)
            # The reference is recommended, not required: without it free-text answers are
            # simply not re-checked by meaning (a limitation reported in the result).
            problems = courses[0].validate(require_reference=False)
            if problems:
                return ("invalid", problems)
            # Course names (questions / options / etalon) must reach the model readable;
            # student identities stay masked (models.scrubbing).
            from models.scrubbing import learn
            learn(client, course=courses[0])
            return run_all(courses, cfg, client, options, cache=cache)[0]

        # Combined view = all students pooled (also primes the answer cache).
        if not uploads:
            return {"error": "Не найдено файлов .xlsx или .csv во входных данных. Загрузите выгрузку из СДО в формате .xlsx."}
        combined = stage_and_run(uploads, "combined")
        if combined is None:
            return {"error": "Не найдено корректных файлов .xlsx во входных данных."}
        # Validation gate: bad/incomplete input is reported with a clear Russian
        # message instead of running the agents on garbage.
        if isinstance(combined, tuple) and combined and combined[0] == "invalid":
            return {"error": "Некорректные входные данные: " + "; ".join(combined[1])}
        course, result, error = combined
        skipped.extend({"file": d["file"], "reason": d["reason"]} for d in course.skipped)
        if error is not None:
            return {"error": f"Ошибка анализа: {error}", "course_id": course.course_id}

        # Per-group breakdown (only when several files were uploaded). Cache hits keep the
        # repeated grading ~free; insights are NOT recomputed per group.
        groups: list[dict] = []
        if len(uploads) > 1:
            glabels = _group_labels([u.filename for u in uploads])
            for gi, up in enumerate(uploads):
                g = stage_and_run([up], f"group_{gi}")
                if g is None or (isinstance(g, tuple) and g and g[0] == "invalid"):
                    # an unusable group: the combined view already validated; report it below
                    _note_missing_group(skipped, up, glabels[gi])
                    continue
                gcourse, gresult, gerror = g
                if gerror is not None or gresult is None:
                    _note_missing_group(skipped, up, glabels[gi])
                    continue
                groups.append({
                    "label": glabels[gi],
                    "name": fix_mojibake(up.filename),
                    "answer": gresult.get("answer"),
                    "time": gresult.get("time"),
                    "warnings": list((gresult.get("answer") or {}).get("warnings") or [])
                    + list(gcourse.warnings),
                })

    if cache is not None:
        cache.save()

    result["warnings"] = list(dict.fromkeys(
        list((result.get("answer") or {}).get("warnings") or []) + list(course.warnings)
    ))
    groups.sort(key=lambda g: int((re.search(r"(\d+)\s*$", g["label"]) or [0, 0])[1]))
    result["groups"] = groups
    result["course_id"] = course_id
    # Reference is optional: say plainly what the report can and cannot do without it.
    limitations: list[str] = []
    if reference is None and course.needs_reference():
        limitations.append(
            "Эталон не загружен: ответы со свободным вводом (текст, числа) не сверялись с "
            "правильными ответами и не пересматривались по смыслу — в отчёте только оценка "
            "из выгрузки СДО."
        )
    if reference is None and not limitations:
        limitations.append("Эталон не загружен: проверка по эталону не выполнялась.")
    result["input_report"] = _input_report(
        uploads, all_uploads, reference, skipped, groups, course, limitations
    )

    # Agent 4 — insights over the aggregated (combined) result (cheap; never raw answers).
    source_names = [u.filename for u in uploads] + ([reference.filename] if reference else [])
    insight_client = client if use_insights else None
    result["insights"] = {
        "commentary": comment(result, insight_options, insight_client),
        "suggestions": suggest_inputs(
            course, result, source_names=source_names,
            min_samples=cfg.thresholds.min_samples, client=insight_client,
        ),
    }

    if save:
        save_kwargs = {} if history_root is None else {"root": history_root}
        name_labels = [g["label"] for g in groups] or (
            [_group_label(uploads[0].filename, 0)]
            if len(uploads) == 1 and re.search(r"групп|group|gr", fix_mojibake(uploads[0].filename), re.IGNORECASE)
            else []
        )
        result["run_id"] = history.save_run(
            result, name=_run_name(uploads, course_id, name_labels),
            model_group=cfg.model_group, mode=mode, **save_kwargs,
        )
    return result
