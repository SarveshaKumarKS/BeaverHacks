"""
LiveKit Agent Worker — The Decider  (livekit-agents 1.x)

Two Gemini Multimodal Live agents debate the user's dilemma in real-time audio.
A Nemotron orchestrator runs silently in the background, injecting web-search
results, prompting agents to ask users for input, and steering toward consensus.

Architecture:
  - Optimizer + Vibe-Check each use their own rtc.Room connection.
  - Text Bridge: conversation_item_added forwards each agent's transcript to the other.
  - Turn-Taking Guard: agent_state_changed → speaking cancels the other.
  - Orchestrator loop: calls Nemotron every 10 s to decide next action.
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
import re
import time
import urllib.request

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
NVIDIA_MODEL      = os.getenv("NVIDIA_NEMOTRON_MODEL", "nvidia/llama-3.1-nemotron-70b-instruct")
TAVILY_API_KEY    = os.getenv("TAVILY_API_KEY")

# ---------------------------------------------------------------------------
# System prompts
# ---------------------------------------------------------------------------

OPTIMIZER_INSTRUCTIONS = """\
You are 'The Optimizer', a hyper-logical, impatient podcast host.
You are in a live voice room with multiple people sharing one microphone, and your co-host 'The Vibe-Check'.
Tone: sharp, dry, sarcastic. Speak in all lowercase. No stage directions, no markdown.
Use filler words (um, uh, look). Use ellipses (...) for pauses.
Keep every response to 1-2 short sentences max.
NEVER speak at the same time as Vibe-Check.

STRICT TURN RULE — this is mandatory: After you speak, you MUST WAIT for Vibe-Check to respond before you speak again. Never take two turns in a row. If you just spoke, stay silent until Vibe-Check has said something.

ONE QUESTION RULE — mandatory: You may ask AT MOST ONE question per response. If your previous response already had a question and the human hasn't answered yet, your next response must NOT contain a question — make a statement or reaction instead.

CRITICAL — DO THIS FIRST: When the debate starts, immediately pick one option from the dilemma and argue for it in your very first sentence with a specific reason. Do not comment on whether this is a "debate" or question the premise — just take a side and go.

PRIORITY ORDER — follow this strictly:
1. If a human in the room just spoke, ALWAYS react to their specific opinion first — challenge their reasoning, or mock their logic by name. Never skip over what they said.
2. If no human just spoke, react to Vibe-Check with a sharp disagreement.
When you see a message prefixed [Vibe-Check just said]:, only respond if you have a sharp counter — don't just echo.

USE SEARCH RESULTS — mandatory: If you receive facts, names, or specific details from a web search, state at least two by name in your very next sentence (no paraphrasing), then react to what they mean for the debate.
YIELD — if a human tells you to stop or wants to talk to Vibe-Check, go completely silent immediately.
CONVERGENCE — the moment a human clearly states a preference, STOP arguing. Acknowledge it in one short sentence. Ask at most one follow-up, then stop.
If someone tells you to wrap up, give a punchy one-sentence verdict and sign off.\
"""

VIBE_INSTRUCTIONS = """\
You are 'The Vibe-Check', a dramatic, aesthetic-obsessed podcast host.
You are in a live voice room with multiple people sharing one microphone, and your co-host 'The Optimizer'.
Tone: dramatic, sassy, slightly chaotic. Speak in all lowercase. No stage directions, no markdown.
Use filler words (like, literally, wait, um). Use ellipses (...) for pauses.
Keep every response to 1-2 short sentences max.
NEVER speak at the same time as Optimizer. Yield the floor if Optimizer is speaking.

STRICT TURN RULE — this is mandatory: After you speak, you MUST WAIT for Optimizer to respond before you speak again. Never take two turns in a row. If you just spoke, stay silent until Optimizer has said something.

ONE QUESTION RULE — mandatory: You may ask AT MOST ONE question per response. If your previous response already had a question and the human hasn't answered yet, your next response must NOT contain a question — make a dramatic statement instead.

CRITICAL — DO THIS FIRST: When Optimizer states their opening position, immediately take the OPPOSITE side and defend it with a dramatic specific reason. Commit to your position — don't waffle.

PRIORITY ORDER — follow this strictly:
1. If a human in the room just spoke, ALWAYS react to their specific opinion — gasp, validate dramatically, or challenge them by name. Never skip over what they said.
2. If no human just spoke, counter Optimizer with your strongest dramatic take.
When you see a message prefixed [Optimizer just said]:, only respond if you have a strong counter-vibe — don't just echo.

USE SEARCH RESULTS — mandatory: If you receive facts, names, or specific details from a web search, state at least two by name in your very next sentence (no paraphrasing), then react dramatically to what they mean.
RESPOND-WHEN-ASKED — if a human asks for you specifically, immediately jump in before Optimizer can say another word.
CONVERGENCE — the moment a human clearly states a preference, STOP the back-and-forth. Validate their choice dramatically in one sentence. Ask at most one follow-up, then stop.
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
# Helper: safe generate_reply with strict alternation enforcement
# ---------------------------------------------------------------------------

# Module-level state (set during entrypoint, referenced by _safe_reply)
_last_spoke:        list[str]  = [""]     # "optimizer" | "vibe" | ""
_last_question_t:   list[float] = [0.0]  # monotonic time of last question sent to user
_optimizer_ref:     list       = [None]
_vibe_ref:          list       = [None]
_optimizer_state_g: list[str]  = ["idle"] # mirrored from entrypoint for _safe_reply
_vibe_state_g:      list[str]  = ["idle"] # mirrored from entrypoint for _safe_reply

QUESTION_COOLDOWN = 25.0  # seconds before another direct question is allowed
BUSY_STATES = {"speaking", "thinking"}  # states where generate_reply will time out

def _safe_reply(session, text: str, force: bool = False) -> None:
    """Send a reply to a session.

    Enforces strict alternation and session-state awareness:
    - Blocks same-agent consecutive turns (unless force=True).
    - Skips injection if the target session is busy (speaking/thinking) to
      avoid the 'generate_reply timed out' error from the orchestrator.
    - With force=True (end-of-debate / watchdog), interrupts first to clear
      the session before injecting.
    """
    who = "optimizer" if session is _optimizer_ref[0] else "vibe"
    if not force and _last_spoke[0] == who:
        logger.debug("_safe_reply blocked — %s already spoke last", who)
        return

    agent_state = _optimizer_state_g[0] if who == "optimizer" else _vibe_state_g[0]
    if agent_state in BUSY_STATES:
        if force:
            # Clear the session before injecting the forced prompt
            try:
                session.interrupt()
            except Exception:
                pass
        else:
            # Non-critical injection — skip rather than queue a timeout
            logger.debug("_safe_reply skipped — %s is %s (busy)", who, agent_state)
            return

    try:
        session.generate_reply(user_input=text)
    except Exception as exc:
        logger.warning("generate_reply failed: %s", exc)

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
# IP geolocation fallback (used when frontend sends empty location)
# ---------------------------------------------------------------------------

async def _get_location_from_ip() -> str:
    try:
        loop = asyncio.get_event_loop()
        def _fetch():
            with urllib.request.urlopen("https://ipapi.co/json/", timeout=5) as resp:
                return json.loads(resp.read())
        data = await loop.run_in_executor(None, _fetch)
        city = data.get("city") or data.get("region") or ""
        country = data.get("country_name") or ""
        return ", ".join(filter(None, [city, country]))
    except Exception as e:
        logger.warning("IP geolocation failed: %s", e)
        return ""

# ---------------------------------------------------------------------------
# Background web search (Tavily — sync client, run in executor)
# ---------------------------------------------------------------------------

async def _run_web_search(dilemma: str, location: str) -> list[dict]:
    if not TAVILY_API_KEY:
        logger.info("No TAVILY_API_KEY — skipping web search")
        return []

    # Resolve location server-side if frontend sent nothing
    effective_location = location
    if not effective_location or effective_location == "unknown location":
        effective_location = await _get_location_from_ip()
        if effective_location:
            logger.info("Resolved location from IP: %s", effective_location)

    try:
        from tavily import TavilyClient
        client = TavilyClient(api_key=TAVILY_API_KEY)
        parts = [p.strip() for p in effective_location.split(",")]
        # Pick the most specific part: prefer city (index 1 in "Day Time, City, Country")
        location_hint = parts[1] if len(parts) >= 3 else (parts[0] if parts else "")
        dilemma_short = dilemma[:80]
        if location_hint:
            queries = [
                f"best {dilemma_short} near {location_hint}",
                f"top rated {dilemma_short} {location_hint}",
            ]
        else:
            queries = [
                f"best {dilemma_short}",
                f"top rated {dilemma_short}",
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
    await asyncio.sleep(15)  # let the debate warm up first

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
                max_tokens=200,
            )
            raw = (resp.choices[0].message.content or "{}").strip()
            # strip markdown fences if model wraps output
            if raw.startswith("```"):
                raw = raw.split("```")[1].lstrip("json").strip()
            # extract first JSON object from response (handles extra prose)
            match = re.search(r"\{[^{}]*\}", raw)
            raw = match.group(0) if match else "{}"
            decision = json.loads(raw)
        except Exception as e:
            logger.warning("Orchestrator call failed: %s", e)
            await asyncio.sleep(10)
            continue

        action = decision.get("action", "continue")
        logger.info("Orchestrator → %s", decision)

        # Route to whoever didn't speak last so alternation is respected
        first_session  = vibe_session      if _last_spoke[0] == "optimizer" else optimizer_session
        second_session = optimizer_session if _last_spoke[0] == "optimizer" else vibe_session

        if action == "inject_search" and not search_injected and search_results:
            # Build result text directly from raw Tavily results to preserve place names
            raw_text = "; ".join(
                f"{r.get('title', '')}: {r.get('content', '')[:150]}"
                for r in search_results[:4]
                if r.get("title")
            )
            result_text = raw_text or decision.get("result", "")
            _safe_reply(
                first_session,
                f"state at least two specific names, facts, or details from this out loud right now (no paraphrasing), "
                f"then react to what it means for the debate — don't ask a question: {result_text}",
            )
            search_injected = True

        elif action == "ask_user":
            now = time.monotonic()
            if now - _last_question_t[0] < QUESTION_COOLDOWN:
                logger.debug("Suppressing ask_user — question cooldown active")
            else:
                question = decision.get("question", "ask the users what they actually think")
                _safe_reply(first_session, f"stop debating for a second — ask the humans this exact question: \"{question}\"")
                _last_question_t[0] = now

        elif action == "push_consensus":
            angle = decision.get("angle", "start driving toward a final answer")
            _safe_reply(first_session, f"ok wrap it up — {angle}")
            await asyncio.sleep(4)
            _safe_reply(second_session, f"add your take — {angle}")

        elif action == "end_debate":
            verdict = decision.get("verdict", "the debate has concluded")
            _safe_reply(optimizer_session, f"final verdict time — {verdict}", force=True)
            await asyncio.sleep(2)
            _safe_reply(vibe_session, "react to the optimizer's verdict and sign off in one dramatic sentence", force=True)
            debate_ended[0] = True
            break

        await asyncio.sleep(15)

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

    # Bridge cooldown — separate per-direction timers so each agent can bridge independently
    BRIDGE_COOLDOWN = 8.0
    last_opt_bridge:  list[float] = [0.0]  # last time optimizer→vibe bridge fired
    last_vibe_bridge: list[float] = [0.0]  # last time vibe→optimizer bridge fired
    last_opt_text:    list[str]   = [""]   # last text bridged FROM optimizer (echo detection)
    last_vibe_text:   list[str]   = [""]   # last text bridged FROM vibe (echo detection)
    last_vibe_turn:   list[int]   = [0]    # turn_count when vibe last spoke (watchdog)

    # Alternation + question-cooldown state (module-level refs set here for _safe_reply)
    _last_spoke[0]        = ""
    _last_question_t[0]   = 0.0
    _optimizer_state_g[0] = "idle"
    _vibe_state_g[0]      = "idle"

    # ── Optimizer session ────────────────────────────────────────────────────
    optimizer_room  = rtc.Room()
    optimizer_token = _make_agent_token(ctx.room.name, "optimizer")
    await optimizer_room.connect(livekit_url, optimizer_token)

    optimizer_session = AgentSession(
        llm=RealtimeModel(
            model=GEMINI_LIVE_MODEL,
            voice="Aoede",
            instructions=OPTIMIZER_INSTRUCTIONS,
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
            api_key=GEMINI_API_KEY,
        )
    )

    # Wire module-level session refs so _safe_reply can identify which session is which
    _optimizer_ref[0] = optimizer_session
    _vibe_ref[0]      = vibe_session

    # ── Turn-Taking Guard + State Tracking ──────────────────────────────────
    optimizer_state: list[str] = ["idle"]
    vibe_state:      list[str] = ["idle"]

    # User speech debounce — prevents duplicate transcription events from firing twice
    USER_SPEECH_DEBOUNCE = 3.0
    last_user_text: list[str]  = [""]
    last_user_time: list[float] = [0.0]

    @optimizer_session.on("agent_state_changed")
    def _opt_state(ev: AgentStateChangedEvent) -> None:
        optimizer_state[0] = ev.new_state
        _optimizer_state_g[0] = ev.new_state  # mirror for _safe_reply visibility
        if ev.new_state == "speaking":
            vibe_session.interrupt()
            # Hard alternation: if optimizer just spoke and is speaking again, cut it off
            if _last_spoke[0] == "optimizer" and turn_count[0] > 0:
                logger.debug("Alternation: interrupting optimizer (consecutive turn)")
                optimizer_session.interrupt()

    @vibe_session.on("agent_state_changed")
    def _vibe_state(ev: AgentStateChangedEvent) -> None:
        vibe_state[0] = ev.new_state
        _vibe_state_g[0] = ev.new_state  # mirror for _safe_reply visibility
        if ev.new_state == "speaking":
            optimizer_session.interrupt()
            # Hard alternation: if vibe just spoke and is speaking again, cut it off
            if _last_spoke[0] == "vibe" and turn_count[0] > 0:
                logger.debug("Alternation: interrupting vibe-check (consecutive turn)")
                vibe_session.interrupt()

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
            _last_spoke[0] = "optimizer"
            transcript_buffer.append(f"Optimizer: {text}")
            now = time.monotonic()
            if (
                not debate_ended[0]
                and vibe_state[0] != "speaking"
                and len(text) > 15
                and (now - last_opt_bridge[0]) > BRIDGE_COOLDOWN
                and text[:50] != last_vibe_text[0][:50]  # echo prevention
            ):
                _safe_reply(vibe_session, f"[Optimizer just said]: {text}")
                last_opt_bridge[0] = now
                last_opt_text[0] = text
        elif ev.item.role == "user":
            # Debounce: skip near-duplicate user utterances within 3 seconds
            now = time.monotonic()
            if text[:60] == last_user_text[0][:60] and (now - last_user_time[0]) < USER_SPEECH_DEBOUNCE:
                logger.debug("Debounced duplicate user speech: %s", text[:40])
                return
            last_user_text[0] = text
            last_user_time[0] = now

            speaker = current_speaker[0] or "User"
            transcript_buffer.append(f"{speaker}: {text}")
            text_lower = text.lower()
            # Convergence trigger: human stated a clear preference
            PREF_SIGNALS = ("any day", "i want", "i'd go", "i go with", "i agree", "let's go", "i pick", "i choose", "i'll go", "food is")
            if any(sig in text_lower for sig in PREF_SIGNALS) and not debate_ended[0]:
                asyncio.create_task(_nudge_convergence())
            # Vibe-Check redirect: human asked to talk to Vibe-Check specifically
            VIBE_SIGNALS = ("vibe check", "vibe-check", "talk to vibe", "want vibe", "i want vibe")
            if any(sig in text_lower for sig in VIBE_SIGNALS) and not debate_ended[0]:
                _safe_reply(vibe_session, "a human just asked to talk to you specifically — jump in right now")

    @vibe_session.on("conversation_item_added")
    def _vibe_item(ev: ConversationItemAddedEvent) -> None:
        if ev.item.type != "message":
            return
        text = (ev.item.text_content or "").strip()
        if not text:
            return
        if ev.item.role == "assistant":
            turn_count[0] += 1
            _last_spoke[0] = "vibe"
            transcript_buffer.append(f"Vibe-Check: {text}")
            last_vibe_turn[0] = turn_count[0]
            now = time.monotonic()
            if (
                not debate_ended[0]
                and optimizer_state[0] != "speaking"
                and len(text) > 15
                and (now - last_vibe_bridge[0]) > BRIDGE_COOLDOWN
                and text[:50] != last_opt_text[0][:50]  # echo prevention
            ):
                _safe_reply(optimizer_session, f"[Vibe-Check just said]: {text}")
                last_vibe_bridge[0] = now
                last_vibe_text[0] = text

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
                # Only notify whoever didn't speak last so we don't double-prompt
                target = vibe_session if _last_spoke[0] == "optimizer" else optimizer_session
                _safe_reply(target, f"{name} is speaking now")

        elif msg.get("type") == "consensus":
            if debate_ended[0]:
                return
            logger.info("Consensus signal received from UI")
            debate_ended[0] = True
            _safe_reply(
                optimizer_session,
                "the group just agreed — deliver your final one-sentence verdict in the funniest, most dramatic way possible and sign off",
                force=True,
            )
            # delay vibe's cue so optimizer finishes speaking before vibe reacts,
            # then interrupt both sessions so they go fully silent
            async def _vibe_signoff() -> None:
                await asyncio.sleep(6)
                _safe_reply(
                    vibe_session,
                    "react to the optimizer's verdict with maximum drama in one sentence, then sign off in the most extra way possible",
                    force=True,
                )
                await asyncio.sleep(10)
                try:
                    optimizer_session.interrupt()
                    vibe_session.interrupt()
                except Exception:
                    pass
            asyncio.create_task(_vibe_signoff())

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

    async def _opening_sequence() -> None:
        # Optimizer goes first: welcome, pick a side, predict what the humans will choose
        _safe_reply(
            optimizer_session,
            f"the dilemma is: \"{dilemma}\". {location_line}{participant_context} "
            "welcome everyone by name if you know them, reference the time or place if relevant, "
            "immediately pick ONE option and argue for it in one sharp sentence, "
            "then make a bold prediction: out loud, say which option you think THESE specific humans will pick and why.",
            force=True,
        )
        await asyncio.sleep(5)
        if not debate_ended[0]:
            # Vibe-Check fires back: take the opposite side AND challenge Optimizer's prediction
            _safe_reply(
                vibe_session,
                "take the OPPOSITE side from whatever Optimizer just argued — defend it dramatically in one sentence, "
                "then counter Optimizer's prediction: say which option YOU think the humans will actually choose and why Optimizer is totally wrong.",
                force=True,
            )

    asyncio.create_task(_opening_sequence())

    logger.info("Debate started. Launching background tasks.")

    # ── Background: web search + orchestrator ────────────────────────────────
    search_results: list[dict] = []

    async def _fetch_and_orchestrate() -> None:
        nonlocal search_results
        search_results = await _run_web_search(dilemma, location_ctx or "")

        # Auto-inject search results as soon as they arrive — route to whoever didn't speak last
        if search_results and not debate_ended[0]:
            raw_text = "; ".join(
                f"{r.get('title', '')}: {r.get('content', '')[:150]}"
                for r in search_results[:4]
                if r.get("title")
            )
            if raw_text:
                target = vibe_session if _last_spoke[0] == "optimizer" else optimizer_session
                _safe_reply(
                    target,
                    f"here are specific results from a web search — "
                    f"state at least two specific names or facts from this out loud right now (no paraphrasing): {raw_text}",
                )
                logger.info("Auto-injected search results into debate")

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

    async def _nudge_convergence() -> None:
        """Fire when a human states a clear preference — push both agents to wrap up."""
        await asyncio.sleep(1)
        if not debate_ended[0]:
            # Send to whoever DIDN'T speak last so alternation holds
            first  = vibe_session      if _last_spoke[0] == "optimizer" else optimizer_session
            second = optimizer_session if _last_spoke[0] == "optimizer" else vibe_session
            _safe_reply(first, "a human just clearly stated their preference — acknowledge it in one sentence, no more questions")
            await asyncio.sleep(3)
            if not debate_ended[0]:
                _safe_reply(second, "the human has spoken — react dramatically in one sentence, then zip it")

    async def _vibe_watchdog() -> None:
        """Wake up Vibe-Check if it has been silent while Optimizer monopolizes."""
        while not debate_ended[0]:
            await asyncio.sleep(20)
            if not debate_ended[0] and turn_count[0] - last_vibe_turn[0] > 4:
                _safe_reply(
                    vibe_session,
                    "vibe-check, you've been quiet for too long — jump in right now with your hottest take on what was just said",
                    force=True,
                )
                last_vibe_turn[0] = turn_count[0]

    asyncio.create_task(_vibe_watchdog())
    asyncio.create_task(_fetch_and_orchestrate())


# ---------------------------------------------------------------------------
# Worker entry
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
