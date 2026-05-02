from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from uuid import uuid4

from .llm import LLMClients
from .models import ActiveSession, AgentName, TranscriptMessage
from .parsing import choose_winner, extract_constraints, parse_consensus, parse_interrogation
from .social_debt import debt_modifier_for, get_social_debt, record_consensus

EmitFn = Callable[[str, dict, str | None], Awaitable[None]]


class SessionManager:
    def __init__(self, llm: LLMClients):
        self.llm = llm
        self.sessions: dict[str, ActiveSession] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self.lock = asyncio.Lock()

    async def create_session(self, group_id: str, dilemma: str) -> ActiveSession:
        debt = get_social_debt(group_id)
        session = ActiveSession(
            session_id=str(uuid4()),
            group_id=group_id,
            dilemma=dilemma,
            social_debt_modifier=debt_modifier_for(debt.debt_balance),
            debt_balance=debt.debt_balance,
        )
        self.sessions[session.session_id] = session
        return session

    def get(self, session_id: str) -> ActiveSession | None:
        return self.sessions.get(session_id)

    async def start_loop(self, session_id: str, emit: EmitFn) -> None:
        await self.cancel_loop(session_id)
        task = asyncio.create_task(self._debate_loop(session_id, emit))
        self.tasks[session_id] = task

    async def cancel_loop(self, session_id: str) -> None:
        task = self.tasks.pop(session_id, None)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def handle_interjection(self, session_id: str, text: str, emit: EmitFn) -> ActiveSession | None:
        await self.cancel_loop(session_id)
        session = self.get(session_id)
        if not session:
            return None
        session.transcript.append(TranscriptMessage(speaker="User", text=text))
        session.current_turn = 0
        session.status = "active"
        session.final_decision = None
        session.winner = None
        session.known_constraints.update(extract_constraints(text))
        await emit("room_state_update", session.model_dump(mode="json"), session_id)
        await self.start_loop(session_id, emit)
        return session

    async def _debate_loop(self, session_id: str, emit: EmitFn) -> None:
        session = self.sessions[session_id]
        while session.current_turn < session.max_turns and session.status == "active":
            session.current_turn += 1
            agent: AgentName = "Optimizer" if session.current_turn % 2 == 1 else "Vibe-Check"
            force = session.current_turn >= session.max_turns
            if session.current_turn == 4:
                session.transcript.append(
                    TranscriptMessage(
                        speaker="System",
                        text="The debate has stalled. You owe social debt. You MUST propose a compromise this turn.",
                    )
                )

            await emit("agent_typing", {"speaker": agent}, session_id)
            await emit("room_state_update", session.model_dump(mode="json"), session_id)

            full_text = ""
            async for chunk in self.llm.stream_agent(agent, session, force=force):
                full_text += chunk
                await emit("message_chunk", {"speaker": agent, "chunk": chunk}, session_id)

            session.transcript.append(TranscriptMessage(speaker=agent, text=full_text))
            missing = parse_interrogation(full_text)
            if missing and not force:
                session.status = "paused_for_interrogation"
                await emit("interrogation_triggered", {"missing_fields": missing}, session_id)
                await emit("room_state_update", session.model_dump(mode="json"), session_id)
                return

            decision = parse_consensus(full_text)
            if decision or force:
                final_decision = decision or full_text.strip()
                winner = choose_winner(full_text, fallback=agent)
                debt = record_consensus(session.group_id, session.dilemma, winner)
                session.status = "consensus_reached"
                session.final_decision = final_decision
                session.winner = winner
                session.debt_balance = debt.debt_balance
                session.social_debt_modifier = debt_modifier_for(debt.debt_balance)
                await emit(
                    "consensus_reached",
                    {
                        "final_decision": final_decision,
                        "winner": winner,
                        "new_debt_balance": debt.debt_balance,
                    },
                    session_id,
                )
                await emit("room_state_update", session.model_dump(mode="json"), session_id)
                return

            await emit("room_state_update", session.model_dump(mode="json"), session_id)

