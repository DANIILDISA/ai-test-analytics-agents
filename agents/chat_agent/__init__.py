"""Agent C2 — the КОРПУС chat agent core.

A provider-agnostic tool-calling loop over the existing C1 engine. Tools read
``core.history`` and stored result dicts; read tools return render-ready card
structures (numbers from code, never the LLM). Threads persist as on-disk JSON.
"""

from agents.chat_agent import threads
from agents.chat_agent.loop import LoopResult, run_turn
from agents.chat_agent.tools import build_registry

__all__ = ["threads", "run_turn", "LoopResult", "build_registry"]
