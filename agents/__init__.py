"""The three independent analysis agents.

Each sub-package is a standalone module that can run on its own or be chained by
``pipeline.runner``:

* ``answer_agent`` — Agent 1: answer comparison vs. the reference set.
* ``time_agent``   — Agent 2: per-question / per-user timing anomalies.
* ``report_agent`` — Agent 3: human- and machine-readable reports.

Shared data types live in ``core.models``; agents must not duplicate them
(keeping a single shared source is what preserves modularity between agents).
"""
