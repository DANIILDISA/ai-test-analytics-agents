"""РФ (Russian) LLM adapters: GigaChat, YandexGPT, etc.

Each adapter implements the shared model interface so it is interchangeable with
the ``models.foreign`` adapters. Per-course token cap: see ``token_budget`` in config.yaml (safety guard only).

TODO (later increment): add ``gigachat.py`` / ``yandexgpt.py`` adapters.
"""
