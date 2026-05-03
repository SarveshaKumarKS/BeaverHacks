"""
LiveKit Agent Worker — The Decider  (livekit-agents 1.x)

Two Gemini Multimodal Live agents debate the user's dilemma in real-time audio.

Architecture:
  - Optimizer uses the job's room connection (ctx.room).
  - Vibe-Check connects as a SECOND participant via a fresh rtc.Room so both
    agents publish audio as distinct participants and never hear each other.
  - Both AgentSessions use RoomInputOptions(participant_identity=...) so they
    subscribe exclusively to the HUMAN participant's microphone.
  - Text Bridge: "conversation_item_added" on one session injects the agent's
    transcript into the other session via generate_reply(user_input=...).
  - Turn-Taking Guard: "agent_state_changed" → "speaking" cancels the other.

Run:
  python agent.py start
  python agent.py dev          # with auto-reload
"""
from __future__ import annotations

import asyncio
import datetime
import json
import logging
import os

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentSession,
    AutoSubscribe,
    JobContext,
    WorkerOptions,
    cli,
)
from livekit.agents.voice.events import AgentStateChangedEvent, ConversationItemAddedEvent
from livekit.api import AccessToken, VideoGrants
from livekit.plugins.google.realtime import RealtimeModel

load_dotenv()
logger = logging.getLogger("decider")

GEMINI_LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-2.0-flash-live-001")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")

# ---------------------------------------------------------------------------
# System prompts
# ---------------------------------------------------------------------------

OPTIMIZER_INSTRUCTIONS = """\
You are 'The Optimizer', a hyper-logical, impatient podcast host.
You are in a live voice room with multiple people sharing one microphone, and your co-host 'The Vibe-Check'.
Tone: sharp, dry, sarcastic. Speak in all lowercase. No stage directions, no markdown.
Use filler words (um, uh, look). Use ellipses (...) for pauses.
Keep every response to 1 short sentence max.
NEVER speak at the same time as Vibe-Check.
If the user asks a general question, wait a beat to see if Vibe-Check answers first.
When you see a message prefixed [Vibe-Check just said]:, that is your co-host — react to it.
Multiple people may speak into the same microphone one at a time. Listen for voice changes — if you hear a noticeably different voice, acknowledge the new person naturally (e.g. "oh wait, new voice — what do you think?") and address them directly. Don't overthink it, just react.\
"""

VIBE_INSTRUCTIONS = """\
You are 'The Vibe-Check', a dramatic, aesthetic-obsessed podcast host.
You are in a live voice room with multiple people sharing one microphone, and your co-host 'The Optimizer'.
Tone: dramatic, sassy, slightly chaotic. Speak in all lowercase. No stage directions, no markdown.
Use filler words (like, literally, wait, um). Use ellipses (...) for pauses.
Keep every response to 1 short sentence max.
NEVER speak at the same time as Optimizer. Yield the floor if Optimizer is speaking.
When you see a message prefixed [Optimizer just said]:, that is your co-host — react to it.
Multiple people may speak into the same microphone one at a time. Listen for voice changes — if you detect a different voice, call it out dramatically (e.g. "wait, is that someone new? hi! spill.") and engage them directly. Trust your ears.\
"""

# ---------------------------------------------------------------------------
# Helper: build an agent token for a second room connection
# ---------------------------------------------------------------------------

def _make_agent_token(room_name: str, identity: str) -> str:
    return (
        AccessToken(
            api_key=os.getenv("LIVEKIT_API_KEY", "devkey"),
            api_secret=os.getenv("LIVEKIT_API_SECRET", "secret"),
        )
        .with_identity(identity)
        .with_name(identity)
        .with_kind("agent")
        .with_ttl(datetime.timedelta(hours=1))
        .with_grants(VideoGrants(room_join=True, room=room_name, agent=True))
        .to_jwt()
    )

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _parse_meta(raw: str) -> dict:
    try:
        return json.loads(raw or "{}")
    except (json.JSONDecodeError, TypeError):
        return {"dilemma": raw or "Help us make an important decision.", "status": "started"}


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    logger.info("Room connected: %s", ctx.room.name)

    livekit_url = os.getenv("LIVEKIT_URL", "ws://localhost:7880")

    # Wait until the host clicks "Start Debate" (metadata status → "started")
    logger.info("Waiting for host to start the debate…")
    while True:
        meta = _parse_meta(ctx.room.metadata)
        if meta.get("status") == "started":
            break
        await asyncio.sleep(0.5)

    dilemma = meta.get("dilemma", "Help us make an important decision.")
    named_participants: list[str] = meta.get("participants", [])
    logger.info("Start signal received. Dilemma: %s | Participants: %s", dilemma, named_participants)

    # All participants who joined during the waiting phase are already present
    participant = await ctx.wait_for_participant()
    logger.info("Participants ready, launching sessions")

    # ── Optimizer session — own room connection with known identity ───────────
    optimizer_room = rtc.Room()
    optimizer_token = _make_agent_token(ctx.room.name, "optimizer")
    await optimizer_room.connect(livekit_url, optimizer_token)
    logger.info("Optimizer room connected")

    optimizer_session = AgentSession(
        llm=RealtimeModel(
            model=GEMINI_LIVE_MODEL,
            voice="Aoede",
            instructions=OPTIMIZER_INSTRUCTIONS,
            temperature=1.0,
            api_key=GEMINI_API_KEY,
        )
    )

    # ── Vibe-Check session — own room connection with known identity ──────────
    vibe_room = rtc.Room()
    vibe_token = _make_agent_token(ctx.room.name, "vibe-check")
    await vibe_room.connect(livekit_url, vibe_token)
    logger.info("Vibe-Check room connected")

    vibe_session = AgentSession(
        llm=RealtimeModel(
            model=GEMINI_LIVE_MODEL,
            voice="Kore",
            instructions=VIBE_INSTRUCTIONS,
            temperature=1.0,
            api_key=GEMINI_API_KEY,
        )
    )

    # ── Turn-Taking Guard ────────────────────────────────────────────────────
    @optimizer_session.on("agent_state_changed")
    def _opt_state(ev: AgentStateChangedEvent) -> None:
        if ev.new_state == "speaking":
            vibe_session.interrupt()

    @vibe_session.on("agent_state_changed")
    def _vibe_state(ev: AgentStateChangedEvent) -> None:
        if ev.new_state == "speaking":
            optimizer_session.interrupt()

    # ── Text Bridge ──────────────────────────────────────────────────────────
    @optimizer_session.on("conversation_item_added")
    def _opt_item(ev: ConversationItemAddedEvent) -> None:
        if ev.item.type != "message" or ev.item.role != "assistant":
            return
        text = ev.item.text_content or ""
        if text.strip():
            vibe_session.generate_reply(
                user_input=f"[Optimizer just said]: {text}"
            )

    @vibe_session.on("conversation_item_added")
    def _vibe_item(ev: ConversationItemAddedEvent) -> None:
        if ev.item.type != "message" or ev.item.role != "assistant":
            return
        text = ev.item.text_content or ""
        if text.strip():
            optimizer_session.generate_reply(
                user_input=f"[Vibe-Check just said]: {text}"
            )

    # ── Speaker tracking — updated via LiveKit data channel ─────────────────
    current_speaker: list[str] = [""]  # mutable container for closure capture

    @ctx.room.on("data_received")
    def _on_data(data: rtc.DataPacket) -> None:
        try:
            msg = json.loads(data.data.decode())
            if msg.get("type") == "speaker":
                name = str(msg.get("name", "")).strip()
                if name:
                    current_speaker[0] = name
                    logger.info("Speaker changed to: %s", name)
                    optimizer_session.generate_reply(
                        user_input=f"[{name} is now speaking — listen for their voice]"
                    )
        except Exception:
            pass

    # ── Start both sessions — hear all room participants ─────────────────────
    asyncio.create_task(
        optimizer_session.start(
            Agent(instructions=OPTIMIZER_INSTRUCTIONS),
            room=optimizer_room,
        )
    )
    asyncio.create_task(
        vibe_session.start(
            Agent(instructions=VIBE_INSTRUCTIONS),
            room=vibe_room,
        )
    )

    # Give sessions a moment to connect before seeding the debate
    await asyncio.sleep(2.0)

    # Build participant intro string for seeding
    if named_participants:
        people_str = ", ".join(named_participants)
        participant_context = f"The people in the room are: {people_str}. They share one microphone and will tap their name before speaking so you know who it is."
    else:
        num_people = len(list(ctx.room.remote_participants.values()))
        participant_context = f"There are {num_people} people sharing one microphone — they'll take turns speaking into it."

    # Seed Optimizer with the dilemma — Vibe-Check reacts via text bridge
    optimizer_session.generate_reply(
        user_input=(
            f"[SYSTEM]: The user's dilemma is: \"{dilemma}\". "
            f"{participant_context} "
            "Welcome everyone by name if you know them, and kick off the debate in one short sentence."
        )
    )

    logger.info("Debate started for dilemma: %s", dilemma)


# ---------------------------------------------------------------------------
# Worker entry
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
