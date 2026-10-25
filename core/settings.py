# core/settings.py
"""UI-editable settings overlay over the static config.yaml (spec §3, D3/D4/D6).

A small JSON file (git-ignored, under output/) overrides per-component model choices
and, optionally, holds API keys entered through the UI. Resolution order is always
**UI overlay > config.yaml > built-in default**. Keys are read from .env by default;
a UI-entered key is an *optional* override stored locally, masked in any view, and
never written to config.yaml or source. The system works fully from .env alone.

Overlay shape::

    {
      "components": {                     # per-component model selection
        "analysis":   {"provider", "model", "params": {...}},
        "insight":    {...},
        "chat_agent": {..., "params": {"effort": "medium", ...}}
      },
      "keys": {"OPENROUTER_API_KEY": "sk-...", ...}   # OPTIONAL local key overrides
    }
"""

from __future__ import annotations

import json
import os
from pathlib import Path

DEFAULT_PATH = Path("output") / "settings.json"

#: The three configurable LLM components (spec D4). Keys are stable identifiers.
COMPONENTS: tuple[str, ...] = ("analysis", "insight", "chat_agent")


def _empty() -> dict:
    return {"components": {}, "keys": {}, "analysis_defaults": {}}


def load_overlay(*, path: Path | str = DEFAULT_PATH) -> dict:
    """Load the overlay; return an empty overlay if missing or unreadable."""
    p = Path(path)
    if not p.exists():
        return _empty()
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return _empty()
    if not isinstance(data, dict):
        return _empty()
    data.setdefault("components", {})
    data.setdefault("keys", {})
    data.setdefault("analysis_defaults", {})
    return data


def save_overlay(overlay: dict, *, path: Path | str = DEFAULT_PATH) -> None:
    """Persist the overlay as pretty JSON (creating parent dirs as needed)."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    body = {
        "components": overlay.get("components", {}),
        "keys": overlay.get("keys", {}),
        "analysis_defaults": overlay.get("analysis_defaults", {}),
    }
    p.write_text(json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8")


from core.config import ANALYSIS_ASPECT_KEYS, DEFAULT_CONFIG, MAX_LLM_CALLS_LIMIT, load_config


def _config_default(component: str, *, config_path: Path | str = DEFAULT_CONFIG) -> dict:
    """Built-in default for a component = the config.yaml active model group.

    All three components default to the same config.yaml selection until the UI
    overrides them per component (spec D4). ``require_key=False`` so resolution never
    needs a secret present.
    """
    cfg = load_config(config_path, require_key=False)
    mc = cfg.active_model
    return {
        "provider": mc.provider,
        "model": mc.model,
        "params": {"max_tokens": mc.max_tokens, "temperature": mc.temperature},
    }


def resolve_component(
    component: str,
    *,
    overlay: dict | None = None,
    config_path: Path | str = DEFAULT_CONFIG,
) -> dict:
    """Resolve a component's ``{provider, model, params}`` as UI > config.yaml > default.

    Field-by-field: any field present in the UI overlay wins; missing fields fall back
    to the config.yaml default. ``params`` are merged (UI keys override default keys).
    """
    if component not in COMPONENTS:
        raise ValueError(f"Неизвестный компонент: {component!r}. Доступны: {list(COMPONENTS)}")
    overlay = overlay or _empty()
    base = _config_default(component, config_path=config_path)
    ui = (overlay.get("components") or {}).get(component) or {}
    params = dict(base["params"])
    params.update(ui.get("params") or {})
    return {
        "provider": ui.get("provider", base["provider"]),
        "model": ui.get("model", base["model"]),
        "params": params,
    }


#: Env-var names for keys the UI may optionally override (one per provider in config.yaml).
KEY_ENV_NAMES: tuple[str, ...] = (
    "OPENROUTER_API_KEY",
    "GIGACHAT_CREDENTIALS",
    "GIGACHAT_SCOPE",
)


def resolve_key(env_name: str, *, overlay: dict | None = None) -> str | None:
    """Resolve one credential: UI override (if non-empty) else ``os.environ`` else None.

    The UI override is the *optional* hybrid case (spec D6); absent it, the value comes
    from ``.env`` exactly as ``core.config.load_config`` reads it.
    """
    overlay = overlay or _empty()
    ui = (overlay.get("keys") or {}).get(env_name)
    if ui:
        return ui
    val = os.environ.get(env_name)
    return val or None


def mask_secret(value: str | None) -> str:
    """Masked preview of a secret: dots + last 4 chars, or fully masked if too short."""
    if not value:
        return ""
    if len(value) <= 4:
        return "••••"
    return "••••" + value[-4:]


def sanitize_analysis_defaults(raw: dict | None) -> dict:
    """Keep only valid analysis-default fields (a bad value is dropped, never raised).

    Accepted: ``model_group`` (a group of config.yaml ``models``), ``deep`` (bool),
    ``max_llm_calls`` (int 1…MAX_LLM_CALLS_LIMIT), ``aspects`` (subset of insight blocks).
    """
    raw = raw if isinstance(raw, dict) else {}
    out: dict = {}
    groups = _config_model_groups()
    if isinstance(raw.get("model_group"), str) and raw["model_group"] in groups:
        out["model_group"] = raw["model_group"]
    if isinstance(raw.get("deep"), bool):
        out["deep"] = raw["deep"]
    mc = raw.get("max_llm_calls")
    if isinstance(mc, int) and not isinstance(mc, bool) and 1 <= mc <= MAX_LLM_CALLS_LIMIT:
        out["max_llm_calls"] = mc
    if isinstance(raw.get("aspects"), list):
        picked = {a for a in raw["aspects"] if a in ANALYSIS_ASPECT_KEYS}
        out["aspects"] = [a for a in ANALYSIS_ASPECT_KEYS if a in picked]   # canonical order
    return out


def _config_model_groups(*, config_path: Path | str = DEFAULT_CONFIG) -> list[str]:
    return list(load_config(config_path, require_key=False).models)


def resolve_analysis_defaults(
    *, overlay: dict | None = None, config_path: Path | str = DEFAULT_CONFIG
) -> dict:
    """Defaults of a new analysis: UI overlay > config.yaml > built-in.

    Returns ``{model_group, model, provider, deep, max_llm_calls, aspects}``; ``model`` /
    ``provider`` describe the group's configured model (for the «GigaChat Ultra · …» line).
    """
    overlay = overlay or _empty()
    cfg = load_config(config_path, require_key=False)
    d = cfg.analysis_defaults
    merged = {
        "model_group": cfg.model_group,
        "deep": d.deep,
        "max_llm_calls": d.max_llm_calls,
        "aspects": [a for a in ANALYSIS_ASPECT_KEYS if a in set(d.aspects)],
    }
    merged.update(sanitize_analysis_defaults(overlay.get("analysis_defaults")))
    mc = cfg.models.get(merged["model_group"]) or cfg.active_model
    merged["model"] = mc.model
    merged["provider"] = mc.provider
    return merged


def ui_view(*, overlay: dict | None = None, config_path: Path | str = DEFAULT_CONFIG) -> dict:
    """UI-safe settings snapshot: resolved components + per-key status (never raw secrets).

    Each key entry is ``{"set": bool, "source": "ui"|"env"|"none", "preview": str}``.
    ``analysis_defaults`` carries the resolved defaults of a new analysis.
    """
    overlay = overlay or _empty()
    components = {c: resolve_component(c, overlay=overlay, config_path=config_path) for c in COMPONENTS}
    keys: dict[str, dict] = {}
    ui_keys = overlay.get("keys") or {}
    for env_name in KEY_ENV_NAMES:
        if ui_keys.get(env_name):
            source, raw = "ui", ui_keys[env_name]
        elif os.environ.get(env_name):
            source, raw = "env", os.environ[env_name]
        else:
            source, raw = "none", None
        keys[env_name] = {"set": raw is not None, "source": source, "preview": mask_secret(raw)}
    return {
        "components": components,
        "keys": keys,
        "analysis_defaults": resolve_analysis_defaults(overlay=overlay, config_path=config_path),
    }
