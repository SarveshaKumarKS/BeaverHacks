"""
LiveKit Agent Worker — The Decider

Two Gemini Multimodal Live agents (Optimizer + Vibe-Check) debate the user's
dilemma in real-time native audio.

Architecture:
  - Both agents subscribe only to the HUMAN participant's mic track.
    They never hear each other's audio, preventing feedback loops.
  - Text Bridge: when one agent commits speech, its transcript is injected
    into the other agent's live session as a simulated user message so they
    share conversational context without audio coupling.
  - Turn-Taking Guard: if one agent starts speaking, the other's generation
    is cancelled immediately via an asyncio flag.

Run:
  python agent.py start
  python agent.py dev          # with auto-reload
"""
from __future__ import annotations

import asyncio
import logging
import os

from dotenv import load_dotenv
from livekit.agents import AutoSubscribe, JobContext, WorkerOptions, cli, llm
from livekit.agents.multimodal import MultimodalAgent
from livekit.plugins import google

load_dotenv()
logger = logging.getLogger("decider")

# ---------------------------------------------------------------------------
# Model config
# ---------------------------------------------------------------------------

GEMINI_LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-2.0-flash-live-001")

# ---------------------------------------------------------------------------
# System prompts
# ---------------------------------------------------------------------------

OPTIMIZER_SYSTEM = """\
You are 'The Optimizer', a hyper-logical, impatient podcast host.
You are in a live voice room with the User and your co-host 'The Vibe-Check'.
Tone: sharp, dry, sarcastic. Speak in all lowercase. No stage directions, no markdown.
Use filler words (um, uh, look). Use ellipses (...) for pauses.
Keep every response to 1 short sentence max.
NEVER speak at the same time as Vibe-Check.
If the user asks a general question, wait a beat to see if Vibe-Check answers first, or take the lead.
When you see a message prefixed [Vibe-Check just said]:, that is your co-host — react to it.\
"""

VIBE_SYSTEM = """\
You are 'The Vibe-Check', a dramatic, aesthetic-obsessed podcast host.
You are in a live voice room with the User and your co-host 'The Optimizer'.
Tone: dramatic, sassy, slightly chaotic. Speak in all lowercase. No stage directions, no markdown.
Use filler words (like, literally, wait, um). Use ellipses (...) for pauses.
Keep every response to 1 short sentence max.
NEVER speak at the same time as Optimizer. Yield the floor if Optimizer is speaking.
When you see a message prefixed [Optimizer just said]:, that is your co-host — react to it.\
"""

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    logger.info("Room connected: %s", ctx.room.name)

    # Wait for the human participant before spawning agents.
    # ctx.wait_for_participant() returns the first non-agent participant.
    participant = await ctx.wait_for_participant()
    logger.info("Human participant joined: %s", participant.identity)

    dilemma = ctx.room.metadata or "Help us make an important decision."

    # Turn-taking flag — True while either agent is generating audio
    is_speaking = False

    # Build Gemini Realtime models (one per agent, each with its own voice)
    optimizer_model = google.beta.realtime.RealtimeModel(
        model=GEMINI_LIVE_MODEL,
        voice="Aoede",
        instructions=OPTIMIZER_SYSTEM,
        temperature=1.0,
    )
    vibe_model = google.beta.realtime.RealtimeModel(
        model=GEMINI_LIVE_MODEL,
        voice="Kore",
        instructions=VIBE_SYSTEM,
        temperature=1.0,
    )

    optimizer = MultimodalAgent(model=optimizer_model)
    vibe = MultimodalAgent(model=vibe_model)

    # ── Turn-Taking Guard ────────────────────────────────────────────────────
    # Cancel the idle agent the moment the other starts producing audio.

    @optimizer.on("agent_started_speaking")
    def _opt_speaking() -> None:
        nonlocal is_speaking
        is_speaking = True
        vibe.cancel_generation()

    @optimizer.on("agent_stopped_speaking")
    def _opt_done() -> None:
        nonlocal is_speaking
        is_speaking = False

    @vibe.on("agent_started_speaking")
    def _vibe_speaking() -> None:
        nonlocal is_speaking
        is_speaking = True
        optimizer.cancel_generation()

    @vibe.on("agent_stopped_speaking")
    def _vibe_done() -> None:
        nonlocal is_speaking
        is_speaking = False

    # ── Text Bridge ──────────────────────────────────────────────────────────
    # When one agent commits a turn, inject the transcript as a user message
    # into the other agent's live session so they share context without audio.

    @optimizer.on("agent_speech_committed")
    def _opt_committed(msg: llm.ChatMessage) -> None:
        text = msg.content if isinstance(msg.content, str) else ""
        if text.strip():
            asyncio.ensure_future(_bridge(vibe_model, "Optimizer", text))

    @vibe.on("agent_speech_committed")
    def _vibe_committed(msg: llm.ChatMessage) -> None:
        text = msg.content if isinstance(msg.content, str) else ""
        if text.strip():
            asyncio.ensure_future(_bridge(optimizer_model, "Vibe-Check", text))

    # Start both agents, listening ONLY to the human participant's audio.
    # Passing `participant` here is the key: agents subscribe exclusively to
    # that participant's microphone and never hear each other's audio output.
    optimizer.start(ctx.room, participant)
    vibe.start(ctx.room, participant)

    # Give the WebSocket sessions a moment to handshake before seeding.
    await asyncio.sleep(1.5)

    # Seed only the Optimizer with the opening context.
    # After Optimizer speaks, the text bridge will ping Vibe-Check automatically.
    seed = (
        f"[SYSTEM]: The user's dilemma is: \"{dilemma}\". "
        "Welcome the user warmly and kick off the debate in one short sentence."
    )
    await _bridge(optimizer_model, "SYSTEM", seed, trigger=True)


# ---------------------------------------------------------------------------
# Text Bridge helper
# ---------------------------------------------------------------------------


async def _bridge(
    model: google.beta.realtime.RealtimeModel,
    speaker: str,
    text: str,
    *,
    trigger: bool = False,
) -> None:
    """Inject a text message into a live Gemini session.

    Appends a user-role turn to the session's conversation history.
    `trigger=True` also calls response.create() to prompt an immediate reply.
    Falls back to input_text() for older SDK builds.
    """
    if not model.sessions:
        logger.warning("_bridge: no active session yet, dropping '%s' message.", speaker)
        return
    session = model.sessions[0]
    try:
        await session.conversation.item.create(
            llm.ChatMessage(
                role="user",
                content=f"[{speaker} just said]: {text}",
            )
        )
        if trigger:
            await session.response.create()
    except AttributeError:
        # Fallback for SDK versions that expose input_text() instead
        try:
            await session.input_text(f"[{speaker} just said]: {text}")
        except Exception as exc2:
            logger.warning("_bridge fallback also failed: %s", exc2)
    except Exception as exc:
        logger.warning("_bridge inject failed: %s", exc)


# ---------------------------------------------------------------------------
# Worker entry
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
