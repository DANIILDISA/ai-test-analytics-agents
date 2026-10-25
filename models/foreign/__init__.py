"""Foreign LLM adapters: OpenAI / OpenRouter, Anthropic, Gemini, etc.

Each adapter implements the shared model interface so it is interchangeable with
the ``models.russian`` adapters. Token budget target: <50K per course (OpenRouter).

TODO (later increment): add ``openrouter.py`` / ``anthropic.py`` adapters.
"""
