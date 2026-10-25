"""Agent 3 — Reporting.

Aggregates output from Agents 1 and 2 into human- and machine-readable reports
for methodologists: per-course / per-group / per-user summaries, recommendations,
and visualizations. Export formats: JSON, Excel (colour-coded deviation cells),
plain text. All user-facing text is in Russian.

Modules:
* ``generator``  — build the report data + JSON / Excel / text exports.
* ``visualizer`` — charts, tables and code-diff highlighting.
"""
