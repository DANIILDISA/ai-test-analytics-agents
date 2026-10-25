"""On-disk run history so analyses survive restarts and can be compared later.

File-first, no database (this is a local, single-user tool): each run is a directory
under ``output/history/<id>/`` holding the full result; ``index.json`` is a compact list
of run metadata for the history page. Used by the web layer for the History → compare
flow, and reusable from anywhere.
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

DEFAULT_ROOT = Path("output") / "history"


def _index_path(root: Path) -> Path:
    return root / "index.json"


def _meta_from(result: dict, *, run_id: str, created_at: str, name: str, model_group: str, mode: str) -> dict:
    answer = result.get("answer") or {}
    s = answer.get("summary", {}) or {}
    rep = result.get("input_report") or {}
    return {
        "id": run_id,
        "created_at": created_at,
        "name": name,
        "course_id": result.get("course_id"),
        "model_group": model_group,
        "mode": mode,
        # group labels of a multi-group run («Группа 1», …) — used to pick a comparable prior run
        "groups": [g.get("label") for g in (result.get("groups") or []) if g.get("label")],
        # input problems (unreadable / unsupported files) — shown as a badge in the history
        "skipped_files": len(rep.get("skipped") or []),
        "summary": {
            "total_users": s.get("total_users"),
            "total_questions": s.get("total_questions"),
            "avg_score": s.get("avg_score"),
            "critical": sum(1 for q in answer.get("questions", []) if q.get("critical")),
            "real_attempts": s.get("real_attempts"),
            "abandoned": s.get("abandoned"),
        },
    }


def save_run(
    result: dict,
    *,
    name: str = "",
    model_group: str = "",
    mode: str = "",
    root: Path | str = DEFAULT_ROOT,
) -> str:
    """Persist one analysis result; return its run id. Newest entries sort first."""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    run_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    created_at = time.strftime("%Y-%m-%d %H:%M:%S")

    run_dir = root / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "report.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    meta = _meta_from(
        result, run_id=run_id, created_at=created_at,
        name=name or (result.get("course_id") or "анализ"),
        model_group=model_group, mode=mode,
    )
    index = list_runs(root)
    index.insert(0, meta)
    _index_path(root).write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    return run_id


def list_runs(root: Path | str = DEFAULT_ROOT) -> list[dict]:
    """Return run metadata, newest first. Empty list if no history yet."""
    path = _index_path(Path(root))
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return []
    return data if isinstance(data, list) else []


_LOAD_OBSERVERS: list = []


def add_load_observer(callback):
    """Call ``callback(result)`` for every run loaded from now on; returns a ``remove()`` function.
    Lets the chat feed each run the tools touch to the PII scrubber's course-content allowlist."""
    _LOAD_OBSERVERS.append(callback)

    def remove() -> None:
        try:
            _LOAD_OBSERVERS.remove(callback)
        except ValueError:
            pass

    return remove


def load_run(run_id: str, root: Path | str = DEFAULT_ROOT) -> dict | None:
    """Load a stored result by id, or None if it is missing/unreadable."""
    path = Path(root) / run_id / "report.json"
    if not path.exists():
        return None
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None
    for cb in list(_LOAD_OBSERVERS):
        try:
            cb(result)
        except Exception:  # noqa: BLE001 — an observer must never break loading
            pass
    return result


_GENERIC_COURSES = {"", "анализ"}


def course_key(meta: dict) -> str:
    """Key that says «same course» for two history entries.

    The course id (e.g. «ЭК 069») when the run has a real one; otherwise the normalised
    run name (older runs saved the placeholder course «анализ», so only the file name
    tells them apart). Used for the «к прошлому анализу» deltas and the compare defaults."""
    import re as _re

    cid = str(meta.get("course_id") or "").strip()
    if cid.lower() not in _GENERIC_COURSES:
        return "c:" + cid.casefold()
    n = str(meta.get("name") or "").casefold().strip()
    n = _re.sub(r"\.xlsx$", "", n)
    n = _re.sub(r"\s*\(\s*\d+\s*групп[а-я]*\s*\)", "", n)
    n = _re.sub(r"[_\-\s]*групп[а-я]*\s*[_\-]?\s*\d+", "", n)
    return "n:" + n.strip(" _-")


def previous_comparable(runs: list[dict], run_id: str) -> dict | None:
    """The newest run OLDER than ``run_id`` that belongs to the same course (preferring the
    same set of groups). ``runs`` is the newest-first index. None when there is none."""
    ids = [r.get("id") for r in runs]
    if run_id not in ids:
        return None
    idx = ids.index(run_id)
    cur = runs[idx]
    key = course_key(cur)
    if key in ("n:", "c:"):
        return None
    same = [r for r in runs[idx + 1:] if course_key(r) == key]
    if not same:
        return None
    groups = sorted(cur.get("groups") or [])
    for r in same:
        if sorted(r.get("groups") or []) == groups:
            return r
    return same[0]


def rename_run(run_id: str, name: str, root: Path | str = DEFAULT_ROOT) -> bool:
    """Change the display name of a saved run. False if the run is unknown."""
    root = Path(root)
    index = list_runs(root)
    hit = False
    for m in index:
        if isinstance(m, dict) and m.get("id") == run_id:
            m["name"] = name
            hit = True
    if hit:
        _index_path(root).write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    return hit


_ID_RE = __import__("re").compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def is_safe_id(run_id: object) -> bool:
    """True for plain run ids only (no separators, no '..')."""
    return isinstance(run_id, str) and bool(_ID_RE.match(run_id)) and ".." not in run_id


def delete_runs(run_ids: list[str], root: Path | str = DEFAULT_ROOT) -> list[str]:
    """Delete runs (directory with report/exports + index entry). Missing files are
    ignored. Raises ValueError on an unsafe id before touching anything. Returns the
    ids that were actually removed (present in the index or on disk)."""
    import shutil

    ids = list(dict.fromkeys(run_ids))
    bad = [i for i in ids if not is_safe_id(i)]
    if bad:
        raise ValueError(f"Недопустимый id: {bad[0]}")
    root = Path(root)
    removed: list[str] = []
    index = list_runs(root)
    in_index = {m.get("id") for m in index if isinstance(m, dict)}
    for i in ids:
        d = root / i
        existed = d.exists() or i in in_index
        if d.is_dir():
            shutil.rmtree(d, ignore_errors=True)
        elif d.exists():
            try:
                d.unlink()
            except OSError:
                pass
        if existed:
            removed.append(i)
    if removed and _index_path(root).exists():
        keep = [m for m in index if not (isinstance(m, dict) and m.get("id") in set(ids))]
        _index_path(root).write_text(json.dumps(keep, ensure_ascii=False, indent=2), encoding="utf-8")
    return removed
