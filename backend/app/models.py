from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field


AgentName = Literal["Optimizer", "Vibe-Check"]
SessionStatus = Literal["active", "paused_for_interrogation", "consensus_reached"]


class TranscriptMessage(BaseModel):
    speaker: str
    text: str


class DebtHistoryEntry(BaseModel):
    dilemma: str
    winner: AgentName
    impact_score: float = 1.0
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class SocialDebt(BaseModel):
    group_id: str
    debt_balance: float = 0.0
    history: list[DebtHistoryEntry] = Field(default_factory=list)


class ActiveSession(BaseModel):
    session_id: str
    group_id: str
    dilemma: str
    known_constraints: dict[str, str] = Field(
        default_factory=lambda: {
            "time": "Unknown",
            "budget": "Unknown",
            "audience": "Unknown",
            "audience_vibe": "Unknown",
            "team_energy": "Unknown",
        }
    )
    current_turn: int = 0
    max_turns: int = 6
    transcript: list[TranscriptMessage] = Field(default_factory=list)
    social_debt_modifier: str = "No social debt yet. Debate on merit."
    status: SessionStatus = "active"
    debt_balance: float = 0.0
    winner: AgentName | None = None
    final_decision: str | None = None


class CreateRoomPayload(BaseModel):
    group_id: str
    initial_dilemma: str


class JoinRoomPayload(BaseModel):
    session_id: str
    user_name: str


class UserInterjectionPayload(BaseModel):
    session_id: str
    text: str

