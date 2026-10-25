"""Pipeline layer: data loading and agent orchestration.

This package turns raw input files into the structured records the agents
consume, and chains the three agents together:

* ``parsers/``    — Layer-1 parsing of the LMS Excel exports (zero LLM tokens).
* ``data_loader`` — front door that discovers/loads JSON, CSV or a folder of
                    files and returns parsed records.
* ``runner``      — orchestrates Agent 1 -> Agent 2 -> Agent 3 (or any subset).
"""
