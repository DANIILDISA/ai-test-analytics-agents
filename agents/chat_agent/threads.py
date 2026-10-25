# agents/chat_agent/threads.py
"""On-disk chat threads: one JSON file per thread + a compact index.

Mirrors core/history.py (file-first, single-user, no DB). A thread stores its
messages and per-assistant-turn tool traces, its bound context (run_id / comparison
/ course), category (auto), title (renamable), and timestamps. (Spec D11.)
"""

from __future__ import annotations

import json
import shutil
import time
import uuid
from pathlib import Path

DEFAULT_ROOT = Path("output") / "chats"


def _index_path(root: Path) -> Path:
    return root / "index.json"


def uploads_dir(thread_id: str, root: Path | str = DEFAULT_ROOT) -> Path:
    """Directory that stages a thread's uploaded files (root/thread_id/uploads)."""
    return Path(root) / thread_id / "uploads"


def clear_uploads(thread_id: str, root: Path | str = DEFAULT_ROOT) -> None:
    """Remove a thread's staged uploads directory; ignore it if it never existed."""
    shutil.rmtree(uploads_dir(thread_id, root), ignore_errors=True)


def context_run_ids(context: dict | None) -> list[str]:
    """Run ids referenced by a thread context, normalized across shapes.

    The current shape is {"runs": [...]}; legacy shapes are {"compare": [...]}
    and {"run_id": "..."}. Returns [] for None / empty / unrecognized contexts.
    Preserves order and drops falsy ids.
    """
    if not context:
        return []
    runs = context.get("runs")
    if isinstance(runs, list):
        return [str(x) for x in runs if x]
    compare = context.get("compare")
    if isinstance(compare, list):
        return [str(x) for x in compare if x]
    run_id = context.get("run_id")
    if run_id:
        return [str(run_id)]
    return []


def context_with_runs(run_ids: list[str]) -> dict | None:
    """Build a context dict from run ids (order-preserving dedupe, drop falsy).

    Returns {"runs": [...]} or None when nothing remains.
    """
    runs = list(dict.fromkeys(r for r in run_ids if r))
    return {"runs": runs} if runs else None


def new_thread(*, title: str, category: str = "Анализ", context: dict | None = None) -> dict:
    """Build a fresh thread dict (not yet persisted)."""
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    return {
        "id": time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6],
        "title": title,
        "category": category,
        "context": context,
        "created_at": now,
        "updated_at": now,
        "messages": [],
    }


def _meta_from(thread: dict) -> dict:
    return {
        "id": thread["id"],
        "title": thread["title"],
        "category": thread["category"],
        "context": thread["context"],
        "created_at": thread["created_at"],
        "updated_at": thread["updated_at"],
    }


def list_threads(root: Path | str = DEFAULT_ROOT) -> list[dict]:
    """Thread metadata, newest first. Empty list if no threads yet."""
    path = _index_path(Path(root))
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return []
    return data if isinstance(data, list) else []


def load_thread(thread_id: str, root: Path | str = DEFAULT_ROOT) -> dict | None:
    """Load a stored thread by id, or None if missing/unreadable."""
    path = Path(root) / f"{thread_id}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


def save_thread(thread: dict, root: Path | str = DEFAULT_ROOT) -> None:
    """Persist a thread file and upsert its entry at the top of the index."""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    thread["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    (root / f"{thread['id']}.json").write_text(
        json.dumps(thread, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    index = [m for m in list_threads(root) if m["id"] != thread["id"]]
    index.insert(0, _meta_from(thread))
    _index_path(root).write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")


def delete_thread(thread_id: str, root: Path | str = DEFAULT_ROOT) -> bool:
    """Remove a thread file and drop it from the index. Returns True if a file existed."""
    root = Path(root)
    existed = (root / f"{thread_id}.json").exists()
    (root / f"{thread_id}.json").unlink(missing_ok=True)
    index = [m for m in list_threads(root) if m["id"] != thread_id]
    _index_path(root).write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    return existed
