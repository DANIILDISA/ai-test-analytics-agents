"""Application configuration: merges ``config.yaml`` (non-secret) with ``.env`` (secrets).

A single typed ``AppConfig`` is built once and passed around. Nothing about models,
keys, paths or thresholds is hardcoded in Python — it all flows from here. Secrets
are read from the environment variable *named* in ``config.yaml`` (``api_key_env``),
never inlined.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv
from pydantic import BaseModel, Field

from core.exceptions import TestAnalyzerError

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "config.yaml"


class ConfigError(TestAnalyzerError):
    """Raised when configuration or a required secret is missing/invalid."""


class ModelConfig(BaseModel):
    """One model group's settings (e.g. ``foreign`` / ``russian``)."""

    provider: str
    model: str
    api_key_env: str
    base_url: str | None = None
    # GigaChat only: secondary server, model fallback chain, retry policy.
    fallback_base_url: str | None = None
    fallback_models: list[str] = Field(default_factory=list)
    max_retries: int = 3
    retry_backoff: float = 1.0
    # 429 (rate limit; tariff = 1 concurrent stream): wait & retry on the SAME host.
    rate_limit_retries: int = 6
    rate_limit_backoff: float = 4.0     # seconds, doubled each retry (+jitter, or Retry-After)
    rate_limit_max_wait: float = 120.0  # total wait cap per call/host
    scope_env: str | None = None
    reasoning: bool = True
    verify_ssl: bool = True
    max_tokens: int = 1024
    temperature: float = 0.0
    # Resolved from the environment at load time — never present in the YAML.
    api_key: str | None = Field(default=None, repr=False)
    scope: str | None = None


class Thresholds(BaseModel):
    critical_correct_rate: float = 0.5
    fast_factor: float = 0.3
    slow_factor: float = 3.0
    fuzzy_accept: int = 92
    min_samples: int = 10
    pass_score: float = 75.0   # best score (%) from which a listener counts as «прошедший» (reports)


class Paths(BaseModel):
    input: str = "./data/samples"
    reference: str = "./data/etalon"
    output: str = "./output"


#: Insight block keys (agents/insight_agent/options.BLOCK_KEYS) = the «Что анализировать» aspects.
ANALYSIS_ASPECT_KEYS: tuple[str, ...] = ("why_failed", "diagnosis", "anomalies", "recommendations")
MAX_LLM_CALLS_LIMIT = 5000


class AnalysisDefaults(BaseModel):
    """Defaults of the «Новый анализ» run (the Settings screen overlays them, see core.settings)."""

    deep: bool = True                       # «Глубокий анализ с ИИ»
    max_llm_calls: int = 500                # cap on per-answer model calls for one run
    aspects: list[str] = Field(default_factory=lambda: list(ANALYSIS_ASPECT_KEYS))


class AppConfig(BaseModel):
    model_group: str
    models: dict[str, ModelConfig]
    analysis_defaults: AnalysisDefaults = Field(default_factory=AnalysisDefaults)
    thresholds: Thresholds = Field(default_factory=Thresholds)
    paths: Paths = Field(default_factory=Paths)
    token_budget: dict[str, int] = Field(default_factory=dict)
    llm_batch_size: int = 5

    @property
    def active_model(self) -> ModelConfig:
        try:
            return self.models[self.model_group]
        except KeyError:
            raise ConfigError(
                f"Неизвестная группа моделей: {self.model_group!r}. "
                f"Доступны: {sorted(self.models)}"
            )


def load_config(
    path: str | Path = DEFAULT_CONFIG,
    *,
    model_group: str | None = None,
    require_key: bool = True,
) -> AppConfig:
    """Load + validate config, then resolve the active group's secret(s) from env.

    ``model_group`` overrides the YAML's ``model_group`` (e.g. from a CLI flag).
    With ``require_key=True`` a missing API key raises a clear Russian ``ConfigError``.
    """
    load_dotenv(ROOT / ".env")
    p = Path(path)
    if not p.exists():
        raise ConfigError(f"Не найден файл конфигурации: {p}")
    try:
        raw: dict[str, Any] = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise ConfigError(f"Не удалось прочитать config.yaml: {exc}") from exc

    if model_group:
        raw["model_group"] = model_group
    try:
        cfg = AppConfig.model_validate(raw)
    except Exception as exc:  # pydantic ValidationError et al.
        raise ConfigError(f"Ошибка в config.yaml: {exc}") from exc

    active = cfg.active_model
    active.api_key = os.environ.get(active.api_key_env)
    if active.scope_env:
        active.scope = os.environ.get(active.scope_env)
    if require_key and not active.api_key:
        raise ConfigError(
            f"Не задан ключ API: переменная окружения {active.api_key_env} пуста. "
            f"Заполните её в файле .env (см. .env.example)."
        )
    return cfg
