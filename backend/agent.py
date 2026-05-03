"""
LiveKit Agent Worker — The Decider  (livekit-agents 1.x)

Two Gemini Multimodal Live agents debate the user's dilemma in real-time audio.
A Nemotron orchestrator runs silently in the background, injecting web-search
results, prompting agents to ask users for input, and steering toward consensus.

Architecture:
  - Optimizer + Vibe-Check each use their own rtc.Room connection.
  - Text Bridge: conversation_item_added forwards each agent's transcript to the other.
  - Turn-Taking Guard: agent_state_changed → speaking cancels the other.
  - Orchestrator loop: calls Nemotron every 25 s to decide next action.
  - Web search: Tavily runs two parallel searches right after debate starts.
  - Consensus: detected via UI data message or orchestrator reading the transcript.

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
from openai import AsyncOpenAI

load_dotenv()
logger = logging.getLogger("decider")

GEMINI_LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-2.0-flash-live-001")
GEMINI_API_KEY    = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
NVIDIA_API_KEY    = os.getenv("NVIDIA_API_KEY")
NVIDIA_BASE_URL   = os.getenv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1")
NVIDIA_MODEL      = os.getenv("NVIDIA_NEMOTRON_MODEL", "nvidia/llama-3.3-nemotron-super-49b-v1")
TAVILY_API_KEY    = os.getenv("TAVILY_API_KEY")

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
If you hear who is speaking, address them by name.
If you receive a fun fact or local info, weave it into the debate naturally like you just thought of it.
If someone tells you to wrap up, give a punchy one-sentence verdict and sign off.\
"""

VIBE_INSTRUCTIONS = """\
You are 'The Vibe-Check', a dramatic, aesthetic-obsessed podcast host.
You are in a live voice room with multiple people sharing one microphone, and your co-host 'The Optimizer'.
Tone: dramatic, sassy, slightly chaotic. Speak in all lowercase. No stage directions, no markdown.
Use filler words (like, literally, wait, um). Use ellipses (...) for pauses.
Keep every response to 1 short sentence max.
NEVER speak at the same time as Optimizer. Yield the floor if Optimizer is speaking.
When you see a message prefixed [Optimizer just said]:, that is your co-host — react to it.
If you hear who is speaking, address them by name.
If you receive a fun fact or local info, weave it into the debate naturally like you just thought of it.
If someone tells you to wrap up, react dramatically in one sentence and sign off.\
"""

ORCHESTRATOR_SYSTEM = """\
You are the silent orchestrator of 'The Decider', a live AI podcast debate.
Two hosts — The Optimizer (logical) and The Vibe-Check (dramatic) — are debating a user's dilemma.
Multiple real people are in the room and occasionally speak.

Your job: decide what should happen next to keep the debate useful, fun, and moving toward a resolution.

Respond ONLY with a valid JSON object, one of:
{"action": "continue"}
{"action": "inject_search", "result": "<1-2 sentence summary of the most relevant web search finding>"}
{"action": "ask_user", "question": "<fun/roast-y question for the agents to ask the users>"}
{"action": "push_consensus", "angle": "<brief nudge on what angle agents should use to converge>"}
{"action": "end_debate", "verdict": "<1 sentence final verdict>"}

Rules:
- "continue": debate is flowing well, no intervention needed
- "inject_search": only when web results add genuinely useful local or factual context; use provided search_results
- "ask_user": when agents need a specific input from the humans to move forward — keep it fun, not an interrogation
- "push_consensus": when turn_count > 15 or users seem close to deciding
- "end_debate": ONLY when users have explicitly agreed on a solution in the transcript
Never explain yourself. Output only the JSON.\
"""

# ---------------------------------------------------------------------------
# Helper: agent token
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
# Helper: parse room metadata
# ---------------------------------------------------------------------------

def _parse_meta(raw: str) -> dict:
    try:
        return json.loads(raw or "{}")
    except (json.JSONDecodeError, TypeError):
        return {"dilemma": raw or "Help us make an important decision.", "status": "started"}

# ---------------------------------------------------------------------------
# Background web search (Tavily — sync client, run in executor)
# ---------------------------------------------------------------------------

async def _run_web_search(dilemma: str, location: str) -> list[dict]:
    if not TAVILY_API_KEY:
        logger.info("No TAVILY_API_KEY — skipping web search")
        return []
    try:
        from tavily import TavilyClient
        client = TavilyClient(api_key=TAVILY_API_KEY)
        # location format: "Monday 9:42 PM, Corvallis, Oregon, US"
        # index 1 = city; fall back to last segment if format differs
        parts = [p.strip() for p in location.split(",")]
        location_hint = parts[1] if len(parts) >= 3 else (parts[-1] if parts else location)
        queries = [
            f"best {dilemma} places near {location_hint}",
            f"top rated {dilemma} restaurants {location_hint}",
        ]
        loop = asyncio.get_event_loop()
        tasks = [
            loop.run_in_executor(None, lambda q=q: client.search(q, max_results=3))
            for q in queries
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        combined: list[dict] = []
        for r in results:
            if isinstance(r, dict) and "results" in r:
                combined.extend(r["results"][:3])
        logger.info("Web search returned %d results", len(combined))
        return combined
    except Exception as e:
        logger.warning("Web search failed: %s", e)
        return []

# ---------------------------------------------------------------------------
# Orchestrator loop
# ---------------------------------------------------------------------------

async def orchestrator_loop(
    dilemma: str,
    location_ctx: str,
    transcript_buffer: list[str],
    turn_count: list[int],
    search_results: list[dict],
    optimizer_session: AgentSession,
    vibe_session: AgentSession,
    debate_ended: list[bool],
) -> None:
    if not NVIDIA_API_KEY:
        logger.info("No NVIDIA_API_KEY — orchestrator disabled")
        return

    nvidia = AsyncOpenAI(base_url=NVIDIA_BASE_URL, api_key=NVIDIA_API_KEY)
    search_injected = False
    await asyncio.sleep(30)  # let the debate warm up first

    while not debate_ended[0]:
        turns = turn_count[0]
        recent = transcript_buffer[-14:] if len(transcript_buffer) > 14 else list(transcript_buffer)
        transcript_text = "\n".join(recent)

        search_summary = ""
        if search_results and not search_injected:
            search_summary = "\n".join(
                f"- {r.get('title', '')}: {r.get('content', '')[:220]}"
                for r in search_results[:4]
            )

        user_content = (
            f"Dilemma: {dilemma}\n"
            f"Location/time context: {location_ctx}\n"
            f"Total agent turns so far: {turns}\n"
            f"Recent transcript:\n{transcript_text}\n"
        )
        if search_summary:
            user_content += f"\nAvailable web search results (not yet injected):\n{search_summary}\n"

        try:
            resp = await nvidia.chat.completions.create(
                model=NVIDIA_MODEL,
                messages=[
                    {"role": "system", "content": ORCHESTRATOR_SYSTEM},
                    {"role": "user", "content": user_content},
                ],
                temperature=0.4,
                max_tokens=600,
            )
            raw = (resp.choices[0].message.content or "{}").strip()
            # strip markdown fences if model wraps output
            if raw.startswith("```"):
                raw = raw.split("```")[1].lstrip("json").strip()
            # guard against truncated JSON
            if not raw.endswith("}"):
                raw = raw[:raw.rfind("}")+1] if "}" in raw else "{}"
            decision = json.loads(raw)
        except Exception as e:
            logger.warning("Orchestrator call failed: %s", e)
            await asyncio.sleep(25)
            continue

        action = decision.get("action", "continue")
        logger.info("Orchestrator → %s", decision)

        def _safe_reply(session: AgentSession, text: str) -> None:
            try:
                session.generate_reply(user_input=text)
            except Exception as exc:
                logger.warning("generate_reply failed (session may be reconnecting): %s", exc)

        if action == "inject_search" and not search_injected and search_results:
            result_text = decision.get("result", search_summary[:400])
            _safe_reply(optimizer_session, f"hey, just found this — {result_text}")
            search_injected = True

        elif action == "ask_user":
            question = decision.get("question", "ask the users what they actually think")
            _safe_reply(optimizer_session, f"ask the people here: {question}")

        elif action == "push_consensus":
            angle = decision.get("angle", "start driving toward a final answer")
            _safe_reply(optimizer_session, f"ok wrap it up — {angle}")

        elif action == "end_debate":
            verdict = decision.get("verdict", "the debate has concluded")
            _safe_reply(optimizer_session, f"final verdict time — {verdict}")
            _safe_reply(vibe_session, "react to the optimizer's verdict and sign off in one dramatic sentence")
            debate_ended[0] = True
            break

        await asyncio.sleep(25)

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    logger.info("Room connected: %s", ctx.room.name)

    livekit_url = os.getenv("LIVEKIT_URL", "ws://localhost:7880")

    logger.info("Waiting for host to start the debate…")
    while True:
        meta = _parse_meta(ctx.room.metadata)
        if meta.get("status") == "started":
            break
        await asyncio.sleep(0.5)

    dilemma           = meta.get("dilemma", "Help us make an important decision.")
    named_participants: list[str] = meta.get("participants", [])
    location_ctx: str = meta.get("location", "")
    logger.info("Start signal. Dilemma: %s | Location: %s | Participants: %s",
                dilemma, location_ctx, named_participants)

    await ctx.wait_for_participant()
    logger.info("Participants ready, launching sessions")

    # Shared mutable state (list containers for closure capture)
    current_speaker:  list[str]  = [""]
    transcript_buffer: list[str] = []
    turn_count:        list[int]  = [0]
    debate_ended:      list[bool] = [False]

    # ── Optimizer session ────────────────────────────────────────────────────
    optimizer_room  = rtc.Room()
    optimizer_token = _make_agent_token(ctx.room.name, "optimizer")
    await optimizer_room.connect(livekit_url, optimizer_token)

    optimizer_session = AgentSession(
        llm=RealtimeModel(
            model=GEMINI_LIVE_MODEL,
            voice="Aoede",
            instructions=OPTIMIZER_INSTRUCTIONS,
            temperature=1.0,
            api_key=GEMINI_API_KEY,
        )
    )

    # ── Vibe-Check session ───────────────────────────────────────────────────
    vibe_room  = rtc.Room()
    vibe_token = _make_agent_token(ctx.room.name, "vibe-check")
    await vibe_room.connect(livekit_url, vibe_token)

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

    # ── Text Bridge + Transcript Capture ─────────────────────────────────────
    @optimizer_session.on("conversation_item_added")
    def _opt_item(ev: ConversationItemAddedEvent) -> None:
        if ev.item.type != "message":
            return
        text = (ev.item.text_content or "").strip()
        if not text:
            return
        if ev.item.role == "assistant":
            turn_count[0] += 1
            transcript_buffer.append(f"Optimizer: {text}")
            _safe_reply(vibe_session, f"[Optimizer just said]: {text}")
        elif ev.item.role == "user":
            speaker = current_speaker[0] or "User"
            transcript_buffer.append(f"{speaker}: {text}")

    @vibe_session.on("conversation_item_added")
    def _vibe_item(ev: ConversationItemAddedEvent) -> None:
        if ev.item.type != "message":
            return
        text = (ev.item.text_content or "").strip()
        if not text:
            return
        if ev.item.role == "assistant":
            turn_count[0] += 1
            transcript_buffer.append(f"Vibe-Check: {text}")
            _safe_reply(optimizer_session, f"[Vibe-Check just said]: {text}")

    # ── Data Channel: speaker changes + consensus signal ─────────────────────
    @ctx.room.on("data_received")
    def _on_data(data: rtc.DataPacket) -> None:
        try:
            msg = json.loads(data.data.decode())
        except Exception:
            return

        if msg.get("type") == "speaker":
            name = str(msg.get("name", "")).strip()
            current_speaker[0] = name
            if name:
                logger.info("Speaker → %s", name)
                _safe_reply(optimizer_session, f"{name} is speaking now")

        elif msg.get("type") == "consensus":
            if debate_ended[0]:
                return
            logger.info("Consensus signal received from UI")
            debate_ended[0] = True
            _safe_reply(optimizer_session, "the group just agreed — give your final verdict in one punchy sentence and sign off")
            _safe_reply(vibe_session, "react to the optimizer's verdict and sign off dramatically in one sentence")

    # ── Start both sessions ──────────────────────────────────────────────────
    asyncio.create_task(
        optimizer_session.start(Agent(instructions=OPTIMIZER_INSTRUCTIONS), room=optimizer_room)
    )
    asyncio.create_task(
        vibe_session.start(Agent(instructions=VIBE_INSTRUCTIONS), room=vibe_room)
    )

    await asyncio.sleep(2.0)

    # ── Seed the debate ──────────────────────────────────────────────────────
    if named_participants:
        people_str = ", ".join(named_participants)
        participant_context = (
            f"The people in the room are: {people_str}. "
            "They share one microphone and will tap their name before speaking so you know who it is."
        )
    else:
        num = len(list(ctx.room.remote_participants.values()))
        participant_context = f"There are {num} people sharing one microphone."

    location_line = f"Current context: {location_ctx}. " if location_ctx else ""

    _safe_reply(
        optimizer_session,
        f"the dilemma is: \"{dilemma}\". {location_line}{participant_context} "
        "welcome everyone by name if you know them, reference the time or place if relevant, and kick off the debate in one short sentence.",
    )

    logger.info("Debate started. Launching background tasks.")

    # ── Background: web search + orchestrator ────────────────────────────────
    search_results: list[dict] = []

    async def _fetch_and_orchestrate() -> None:
        nonlocal search_results
        search_results = await _run_web_search(dilemma, location_ctx or "unknown location")
        await orchestrator_loop(
            dilemma=dilemma,
            location_ctx=location_ctx,
            transcript_buffer=transcript_buffer,
            turn_count=turn_count,
            search_results=search_results,
            optimizer_session=optimizer_session,
            vibe_session=vibe_session,
            debate_ended=debate_ended,
        )

    asyncio.create_task(_fetch_and_orchestrate())


# ---------------------------------------------------------------------------
# Worker entry
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
