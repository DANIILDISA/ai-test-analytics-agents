"""Domain exceptions for the TestAnalyzer backend."""

from __future__ import annotations


class TestAnalyzerError(Exception):
    """Base class for all TestAnalyzer errors."""


class ParseError(TestAnalyzerError):
    """Raised when an input workbook cannot be parsed into the expected shape."""

    def __init__(self, message: str, *, filepath: str | None = None, sheet: str | None = None):
        self.filepath = filepath
        self.sheet = sheet
        #: Human-readable message WITHOUT the technical «[path | sheet]» suffix.
        self.reason = message
        location = " | ".join(p for p in (filepath, sheet) if p)
        super().__init__(f"{message}" + (f" [{location}]" if location else ""))
