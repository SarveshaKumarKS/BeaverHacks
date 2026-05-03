from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field


AgentName = Literal["Optimizer", "Vibe-Check"]
SessionStatus = Literal[
    "speaking",
    "user_interrupting",
    "awaiting_user_answer",
    "resuming_with_new_context",
    "consensus_reached",
]


class TranscriptMessage(BaseModel):
    speaker: str
    text: str


class OrchestratorDecision(BaseModel):
    """JSON decision emitted by the silent Orchestrator after each turn."""
    next_speaker: Literal["optimizer", "vibe_check", "user"]
    status: "SessionStatus"
    updated_constraints: dict[str, str | None] = Field(default_factory=dict)
    reasoning: str = ""
    final_decision: str | None = None


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
    max_turns: int = 8
    transcript: list[TranscriptMessage] = Field(default_factory=list)
    social_debt_modifier: str = "No social debt yet. Debate on merit."
    status: SessionStatus = "speaking"
    debt_balance: float = 0.0
    winner: AgentName | None = None
    final_decision: str | None = None
    # Podcast state machine
    pending_question: bool = False
    pending_question_asker: AgentName | None = None
    last_speaker: AgentName | None = None


class CreateRoomPayload(BaseModel):
    group_id: str
    initial_dilemma: str


class JoinRoomPayload(BaseModel):
    session_id: str
    user_name: str


class UserInterjectionPayload(BaseModel):
    session_id: str
    text: str
