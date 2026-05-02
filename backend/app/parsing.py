from __future__ import annotations

import re

from .models import AgentName

INTERROGATE_RE = re.compile(r"\[INTERROGATE:\s*([a-zA-Z_ -]+)\]", re.IGNORECASE)
CONSENSUS_RE = re.compile(r"\[CONSENSUS_REACHED\]\s*:?\s*(.+)", re.IGNORECASE | re.DOTALL)


def parse_interrogation(text: str) -> list[str]:
    return [match.strip().lower().replace(" ", "_") for match in INTERROGATE_RE.findall(text)]


def parse_consensus(text: str) -> str | None:
    match = CONSENSUS_RE.search(text)
    if not match:
        return None
    return match.group(1).strip()


def choose_winner(text: str, fallback: AgentName = "Optimizer") -> AgentName:
    lowered = text.lower()
    if "vibe-check" in lowered or "vibe check" in lowered:
        return "Vibe-Check"
    if "optimizer" in lowered:
        return "Optimizer"
    return fallback


def extract_constraints(text: str) -> dict[str, str]:
    lowered = text.lower()
    constraints: dict[str, str] = {}
    patterns = {
        "budget": r"(?:budget|cost|spend|price)\s*(?:is|=|:)?\s*([^.;,\n]+)",
        "time": r"(?:time|deadline|by|tonight|tomorrow|weekend)\s*(?:is|=|:)?\s*([^.;,\n]*)",
        "audience": r"(?:audience|people|guests|users)\s*(?:is|are|=|:)?\s*([^.;,\n]+)",
        "audience_vibe": r"(?:vibe|mood|aesthetic)\s*(?:is|=|:)?\s*([^.;,\n]+)",
        "team_energy": r"(?:energy|morale|capacity)\s*(?:is|=|:)?\s*([^.;,\n]+)",
    }
    for field, pattern in patterns.items():
        match = re.search(pattern, lowered)
        if match:
            value = match.group(1).strip()
            constraints[field] = value or "Provided"
    return constraints

