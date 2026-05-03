# The Decider — Codebase Context

> Read this before touching any code. It covers architecture, every file that matters, all env vars, known gotchas, and the decisions behind them.

---

## Active branch

**`Livekit`** — all active development happens here. `main` is not deployed. Push to `Livekit` for any changes.

---

## What the app does

Two AI voice agents ("The Optimizer" and "The Vibe-Check") debate the user's dilemma in real-time audio inside a shared LiveKit room. Multiple humans join via QR code and share the host's microphone to speak to the agents. A live transcript is rendered in the browser. A silent Nemotron orchestrator runs in the background, injecting web-search results and steering the debate.

---

## Repo layout

```
BeaverHacks/
├── backend/
│   ├── agent.py             ← THE only backend file that runs (LiveKit worker)
│   ├── requirements.txt
│   ├── .env.example
│   └── app/
│       ├── parsing.py       ← legacy, unused by agent.py
│       └── social_debt.py   ← legacy, unused by agent.py
└── frontend/                ← Next.js 16 (App Router)
    ├── netlify.toml
    ├── package.json
    └── src/app/
        ├── layout.tsx
        ├── globals.css
        ├── page.tsx                        ← landing + lobby
        ├── api/token/route.ts              ← JWT + room creation
        ├── api/start/route.ts              ← signals backend to start debate
        └── room/[session_id]/page.tsx      ← live room UI
```

The old FastAPI backend (`main.py`, `llm.py`, `orchestration.py`, `models.py`, `config.py`) has been deleted. Only `parsing.py` and `social_debt.py` survive in `app/` but are not called by anything currently running.

---

## Infrastructure

- **LiveKit Cloud** (`wss://beavorhack-28w72ye0.livekit.cloud`) handles WebRTC signaling and TURN relay. No self-hosted server needed.
- **Backend** runs locally (or any server) with `python agent.py dev`. It connects outbound to LiveKit Cloud as a worker.
- **Frontend** is deployed on **Netlify**. Uses `@netlify/plugin-nextjs` (in `netlify.toml`) to handle dynamic routes and API routes.

---

## Backend — `backend/agent.py`

### How to run
```bash
cd backend
.venv/bin/python agent.py dev    # dev mode with auto-reload
.venv/bin/python agent.py start  # production
```

### Environment variables (`backend/.env`)
```
GEMINI_API_KEY=<your Gemini API key>
GEMINI_LIVE_MODEL=gemini-2.0-flash-live-001   # MUST be this exact string — see critical note below
LIVEKIT_URL=wss://beavorhack-28w72ye0.livekit.cloud
LIVEKIT_API_KEY=<your LiveKit API key>
LIVEKIT_API_SECRET=<your LiveKit API secret>
NVIDIA_API_KEY=<your NVIDIA NIM key>
NVIDIA_NEMOTRON_MODEL=nvidia/llama-3.3-nemotron-super-49b-v1
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
TAVILY_API_KEY=<your Tavily search key>
```

> **Critical:** `GEMINI_LIVE_MODEL` must be `gemini-2.0-flash-live-001`. Models like `gemini-2.5-flash` do not support the Gemini Live (bidiGenerateContent) API and will throw a 1008 policy violation error immediately.

> **Note:** `NVIDIA_API_KEY` and `TAVILY_API_KEY` are optional — if missing, the orchestrator and web search are silently disabled. Both must be set for full functionality.

> **Note:** `tavily-python` is not in `requirements.txt` yet. Run `.venv/bin/pip install tavily-python` manually after setting up the venv.

---

### Architecture

The worker is a single `entrypoint` function registered with `WorkerOptions`. When a user joins a room, LiveKit dispatches a job to this worker.

**Participants in every room:**
| Identity | Who | Audio role |
|---|---|---|
| `host-<timestamp>` | Human host | Publishes mic, subscribed by both agents |
| `optimizer` | Agent — custom token | Publishes TTS audio (voice: Aoede) |
| `vibe-check` | Agent — custom token | Publishes TTS audio (voice: Kore) |
| `guest-<timestamp>` | Additional humans via QR | Listen only; share host's mic in person |
| `<dispatch-id>` | Job worker (`ctx.room`) | Internal — appears as a room participant but is not a human or named agent |

**Why both agents have their own `rtc.Room()` connection:**
Each `AgentSession` publishes audio as a distinct room participant. If two sessions shared one `rtc.Room`, they'd conflict. The job's `ctx.room` is held open (required to keep the job alive) but neither agent publishes through it — they each connect with a custom token via `_make_agent_token(room_name, identity)`.

**Waiting room / start signal flow:**
Room metadata is initialised as `{ dilemma: "...", status: "waiting" }` when the room is created. The backend worker polls `ctx.room.metadata` every 0.5s. When the host clicks "Start Debate", the frontend POSTs to `/api/start` which calls `RoomServiceClient.updateRoomMetadata(roomName, { dilemma, status: "started", participants, location })`. The worker detects the change and proceeds to connect both agent rooms and start sessions.

**Dilemma + location caching (race condition fix):**
The room page reads dilemma and participants from `sessionStorage` on first render (keys: `lk-dilemma-${roomName}`, `lk-participants-${roomName}`). Location is resolved async (browser geolocation → Nominatim → IP fallback) and stored in `locationCtx` state. The `/api/start` POST includes the current `locationCtx`. There is a small race window if the host clicks "Start Debate" before `locationCtx` is populated — location may be empty. Dilemma is always present (sessionStorage fix); location is best-effort.

**IP geolocation fallback:**
If the browser denies geolocation permission, the frontend falls back to `https://ipapi.co/json/` (no API key, no permission prompt) to get city + country. If that also fails, it falls back to the local time + timezone string. Location string format: `"Monday 9:42 PM, Corvallis, Oregon, US"`.

**Multi-speaker design:**
Gemini Live API accepts only a single audio stream — only the host's microphone audio reaches the agents. The workaround: guests physically gather around the host's device and take turns speaking. The frontend sends `speaker` data channel messages when a user taps their name button — both agents are notified so they can address the speaker by name.

**Turn-taking guard:**
```python
@optimizer_session.on("agent_state_changed")
def _opt_state(ev):
    optimizer_state[0] = ev.new_state
    if ev.new_state == "speaking":
        vibe_session.interrupt()
# (mirror for vibe_session)
```
When one agent starts speaking, it immediately calls `interrupt()` on the other. State is tracked in `optimizer_state` / `vibe_state` single-element lists (mutable container trick for closure capture).

**Text bridge + cooldown:**
```python
@optimizer_session.on("conversation_item_added")
def _opt_item(ev):
    now = time.monotonic()
    if vibe_state[0] != "speaking" and len(text) > 15 and (now - last_opt_bridge[0]) > BRIDGE_COOLDOWN:
        _safe_reply(vibe_session, f"[Optimizer just said]: {text}")
        last_opt_bridge[0] = now
# (mirror for vibe_session)
```
Agents never hear each other's audio. Instead, the transcript of each turn is injected into the other agent's context as a user message. `BRIDGE_COOLDOWN = 4.0` seconds prevents rapid back-and-forth echo loops. A 15-character minimum also filters trivial turns.

**`_safe_reply` helper (module level):**
```python
def _safe_reply(session: AgentSession, text: str) -> None:
    try:
        session.generate_reply(user_input=text)
    except Exception as exc:
        logger.warning("generate_reply failed (session may be reconnecting): %s", exc)
```
All `generate_reply` calls go through this. Swallows exceptions during Gemini reconnects. **Must stay at module level** — defining it inside a closure causes `NameError` (was a prior bug).

**Debate seeding:**
After a 2-second sleep (letting sessions connect), the Optimizer is seeded with the dilemma, location context, and participant names from room metadata. Vibe-Check reacts via the text bridge.

**System prompts — PRIORITY ORDER:**
Both agents have a `PRIORITY ORDER` section:
1. If a human just spoke: ALWAYS react to their specific opinion first (by name, challenge/mock/gasp).
2. Only then react to the co-host.

Both agents: "If you receive a fun fact, local info, or a specific place name, say it out loud in your next sentence — do not paraphrase." Response length: 1-2 short sentences max.

---

### Orchestrator loop (`orchestrator_loop`)

Runs every 25 seconds after a 30-second warm-up delay. Uses NVIDIA Nemotron (`nvidia/llama-3.3-nemotron-super-49b-v1`) via OpenAI-compatible API.

**Actions:**
| Action | What happens |
|---|---|
| `continue` | No injection |
| `inject_search` | Injects into Optimizer: `"say a SPECIFIC place name from this out loud in your very next sentence — no paraphrasing, just name it: {result}"` |
| `ask_user` | Sends question to Optimizer immediately; 3s later sends to Vibe as fallback |
| `push_consensus` | Tells Optimizer to wrap toward a verdict |
| `end_debate` | Tells both agents to give verdict + sign off; sets `debate_ended[0] = True` |

**Nemotron JSON reliability:** Nemotron sometimes returns `{}`. Code strips markdown fences and truncation-guards with `raw[:raw.rfind("}")+1]`. Still occasional — defaults safely to `action = "continue"`.

---

### Web search (`_run_web_search`)

Tavily search runs in a thread executor (sync client). Two parallel queries:
- `"best {dilemma} places near {location_hint}"`
- `"top rated {dilemma} restaurants {location_hint}"`

Location hint: `parts[1]` from the location string (index 1 = city in `"Monday 9:42 PM, Corvallis, Oregon, US"`). Falls back to `parts[-1]` if fewer than 3 parts.

---

### Key API facts (livekit-agents 1.x — version 1.5.7 installed)
- `AgentSession` + `Agent` replaces the old `MultimodalAgent` (removed in 1.x)
- `session.interrupt()` replaces `agent.cancel_generation()`
- `"agent_state_changed"` replaces `"agent_started_speaking"`
- `"conversation_item_added"` replaces `"agent_speech_committed"`
- `session.generate_reply(user_input=...)` is the correct way to inject context
- Import path: `from livekit.plugins.google.realtime import RealtimeModel`
- `RoomInputOptions` still exists (ignore the deprecation warning — `RoomOptions` does NOT exist yet in this version)

---

## Frontend — Next.js 16 App Router

### Environment variables (`frontend/.env.local`)
```
LIVEKIT_URL=wss://beavorhack-28w72ye0.livekit.cloud
LIVEKIT_API_KEY=<your LiveKit API key>
LIVEKIT_API_SECRET=<your LiveKit API secret>
```
No `NEXT_PUBLIC_*` vars needed — the WebSocket URL is returned by the token API response and never read from env on the client.

### Key dependencies
```json
"@livekit/components-react": "^2.0.0",
"@livekit/components-styles": "^1.0.0",
"livekit-client": "^2.0.0",
"livekit-server-sdk": "^2.0.0",
"qrcode": "1.5.4"
```

### `@livekit/components-styles` import — important gotcha
Do NOT use `@import "@livekit/components-styles"` in CSS files. The package's `exports` field does not expose the package root, so webpack throws `Package path . is not exported`. The correct import is in `layout.tsx`:
```ts
import "@livekit/components-styles/index.css";
```

---

## File-by-file: frontend

### `src/app/layout.tsx`
Imports `@livekit/components-styles/index.css` and `globals.css`. Has `suppressHydrationWarning` on `<html>` to silence Dark Reader browser extension noise.

### `src/app/globals.css`
Standard Tailwind directives + dark background gradient. No LiveKit import here (moved to layout.tsx).

### `src/app/page.tsx` — Landing + Lobby

**Two views, one page component (`HostLobby`):**
1. **Form view** (default): textarea for the dilemma + optional participant name inputs + "Start the Debate" button.
2. **Lobby view** (after submit): QR code (320×320, dark-themed), copyable share URL, and "Enter Room" button.

**Flow:**
- Submit → POST `/api/token` with `{ roomName, identity, dilemma, participants }`
- Caches `token`, `wsUrl`, `participants`, and `dilemma` in `sessionStorage` keyed by room name
- User clicks "Enter Room" → `router.push(/room/${roomName})`

### `src/app/api/token/route.ts` — Token API

**POST** `/api/token` — host flow:
- Body: `{ roomName, identity, dilemma }`
- Creates the LiveKit room with metadata `{ dilemma, status: "waiting" }` via `RoomServiceClient.createRoom()`
- Returns `{ token, wsUrl, roomName }`

**GET** `/api/token?room=<name>&identity=<id>` — guest flow:
- Returns a fresh participant JWT; identity defaults to `guest-${Date.now()}`

### `src/app/api/start/route.ts` — Start Signal API

**POST** `/api/start`:
- Body: `{ roomName, dilemma, participants, location }`
- Calls `RoomServiceClient.updateRoomMetadata(roomName, { dilemma, status: "started", participants, location })`
- Returns `{ ok: true }`

### `src/app/room/[session_id]/page.tsx` — Live Room

**Token resolution:**
- Host: reads cached token from `sessionStorage`
- Guest: fetches via GET `/api/token?room=...`

**Dilemma initialization:**
`dilemma` state is initialized from `sessionStorage.getItem(`lk-dilemma-${roomName}`)` on first render — not from `roomMetadataChanged` (which arrives async and causes a race condition if used for Start).

**Location resolution (two-phase):**
```typescript
navigator.geolocation.getCurrentPosition(
    async (pos) => { /* Nominatim reverse geocode, 5s timeout */ },
    () => resolveLocationFromIP(),  // fallback: ipapi.co/json/
    { timeout: 5000 }
);
```
Result stored in `locationCtx` state, sent to `/api/start`.

**`RoomInner` — metadata router:**
- `status === "waiting"` → renders `WaitingRoom`
- Otherwise → renders `RoomContent`

**`WaitingRoom`:**
- Filters out agents via `AGENT_IDENTITIES = new Set(["optimizer", "vibe-check"])`.
- Host sees "Start Debate" button → POSTs to `/api/start`
- Guests see "Waiting for host to start…"
- Known cosmetic issue: job worker participant also appears in the list (identity is dispatch-assigned, not in the blocklist). Fix: switch to allowlist `host-*` / `guest-*`.

**`RoomContent`:**
- Two `AgentCard` components (amber = Optimizer, fuchsia = Vibe-Check) with speaking pulse
- `BarVisualizer` (24 bars), `TranscriptPanel`, `ParticipantControls`, `RoomAudioRenderer`

**Speaker name tapping (data channel):**
Users tap a name button → sends `{ type: "speaker", name: "Alice" }`. Backend notifies both agents.

**`ParticipantControls`:**
Uses `useLocalParticipant()` + `setMicrophoneEnabled(true)` on mount so mic is on by default.

**`TranscriptPanel` + `useTranscript` hook:**
- `room.on("transcriptionReceived", ...)` — fired by LiveKit for agent TTS and human STT
- Merges non-final (streaming) segments by segment `id`; dims to 50% opacity until `final: true`
- Auto-scrolls to bottom

**`QRButton` — "Invite" button:**
- Generates 200px dark-themed QR on mount, toggles popover on click

---

## Netlify deployment

`frontend/netlify.toml`:
```toml
[build]
  command = "npm run build"
  publish = ".next"

[[plugins]]
  package = "@netlify/plugin-nextjs"
```

Required Netlify env vars (set in Netlify dashboard):
```
LIVEKIT_URL=wss://beavorhack-28w72ye0.livekit.cloud
LIVEKIT_API_KEY=<key>
LIVEKIT_API_SECRET=<secret>
```

`@netlify/plugin-nextjs` is in `devDependencies`. Required for dynamic routes and API routes to work on Netlify.

---

## Recent changes (session log)

### Session 2 — bug fixes
- **`NameError: _safe_reply`**: Was defined inside `orchestrator_loop` closure. Moved to module level.
- **Race condition — empty dilemma on Start**: `dilemma` state now initialized from `sessionStorage` on first render.
- **No location permission in browser**: Added IP geolocation fallback (`ipapi.co/json/`).
- **1008 Gemini errors at ~20s**: Text bridge was calling `generate_reply` on a speaking session. Fixed with `optimizer_state` / `vibe_state` guard.
- **Location extracting wrong city**: `split(",")[-2]` returned state. Fixed to `parts[1]` (city at index 1).
- **Orchestrator injections not landing**: Made more directive ("stop debating", "ask them this exact question out loud").
- **Agents saying bracket prefixes aloud**: Removed `[SYSTEM]:` and unnatural notations.
- **Web search returning no local results**: Tavily queries now use city name at index 1 of location string.

### Session 3 — engagement improvements
- **PRIORITY ORDER in system prompts**: Agents must react to humans first, co-host second.
- **2-sentence limit**: Increased from 1 to 1-2 sentences to reduce single-word loops.
- **Bridge cooldown (4s)**: Prevents echo loops where agents only talk to each other.
- **Search injection fill-in-the-blank**: `"say a SPECIFIC place name from this out loud — no paraphrasing, just name it"`.
- **ask_user to both agents**: Optimizer first, Vibe gets it 3s later as fallback.
- **Speaker signal to both agents**: Both `optimizer_session` and `vibe_session` notified on speaker tap.

---

## Known issues / decisions log

| Issue | Resolution |
|---|---|
| `gemini-2.5-flash` throws 1008 | Use `gemini-2.0-flash-live-001` only |
| Gemini 1008 at ~2 min | Natural context window limit. Sessions auto-reconnect. `_safe_reply` guard handles errors during reconnect. |
| `livekit-server-sdk` pip package doesn't exist | Token generation stays in Next.js; Python uses `livekit-api` (auto-installed with livekit-agents) |
| `@import "@livekit/components-styles"` breaks webpack | Import via JS in `layout.tsx` using `@livekit/components-styles/index.css` |
| Both agents labeled "You" in transcript | Agent identities must be explicit: `"optimizer"` and `"vibe-check"` via `_make_agent_token` |
| `onConnected` on `<LiveKitRoom>` doesn't receive `Room` arg | Read metadata via `useRoomContext()` + `"roomMetadataChanged"` event |
| `RoomOptions` import fails | Use `RoomInputOptions` — `RoomOptions` doesn't exist in livekit-agents v1.5.7 |
| `transcriptionReceived` participant arg is `Participant \| undefined` | Guard with `if (!participant) return` |
| Hydration mismatch from Dark Reader extension | `suppressHydrationWarning` on `<html>` in `layout.tsx` |
| QR flash on landing | Removed `router.push` from submit; added explicit lobby view with "Enter Room" button |
| Guest mic was always muted | Replaced `VoiceAssistantControlBar` with custom `ParticipantControls` using `useLocalParticipant()` |
| Agents only hear the first participant | Gemini Live API accepts one audio stream. Accepted as demo limitation. |
| Job worker participant appears in waiting room list | Dispatch-assigned identity doesn't match `AGENT_IDENTITIES` blocklist. Known cosmetic issue. Fix: switch to allowlist. |
| Orchestrator returns `{}` occasionally | Nemotron truncates JSON. Truncation guard in place. Defaults to `continue`. |
| `tavily-python` not in requirements.txt | Run `.venv/bin/pip install tavily-python` manually. |
| Location empty in backend logs | Timing race — location resolves async. Dilemma is fixed (sessionStorage); location is best-effort. |

---

## Running locally (full stack)

```bash
# Terminal 1 — backend
cd backend
cp .env.example .env   # fill in real keys
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/pip install tavily-python
.venv/bin/python agent.py dev

# Terminal 2 — frontend
cd frontend
cp .env.example .env.local   # fill in real keys
npm install
npm run dev
```

Open `http://localhost:3000`, enter a dilemma, add participant names, share the QR, then enter the room. All participants join the waiting room first; host clicks "Start Debate" to launch the agents.
