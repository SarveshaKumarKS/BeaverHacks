# The Decider — Codebase Context

> Read this before touching any code. It covers architecture, every file that matters, all env vars, known gotchas, and the decisions behind them.

---

## Active branch

**`Livekit`** — all active development happens here. `main` is not deployed. Push to `Livekit` for any changes.

---

## What the app does

Two AI voice agents ("The Optimizer" and "The Vibe-Check") debate the user's dilemma in real-time audio inside a shared LiveKit room. Multiple humans join via QR code and share the host's microphone to speak to the agents. A live transcript is rendered in the browser. A silent Nemotron orchestrator runs in the background, injecting web-search results and steering the debate toward a decision.

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
NVIDIA_NEMOTRON_MODEL=nvidia/llama-3.1-nemotron-70b-instruct
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

**Location resolution (guaranteed, no race condition):**
Location is resolved on the **landing page** (`page.tsx`) as soon as the page loads — before the room is even created. It's stored in `sessionStorage` as `lk-location-${roomName}` when the room is created. The room page reads it from `sessionStorage` on first render, so the host always has it ready before "Start Debate" is clickable. The "Start Debate" button is disabled and shows "Getting location…" until `locationCtx` is non-empty. The location resolution chain:
1. `navigator.geolocation.getCurrentPosition` → Nominatim reverse geocode (5s timeout)
2. If denied/fails → `https://ipapi.co/json/` (IP geolocation, no permission needed)
3. If that fails → local time + timezone string

Location string format: `"Monday 9:42 PM, Corvallis, Oregon, United States"`.

**Server-side IP geolocation fallback (`_get_location_from_ip`):**
If the frontend somehow sends empty location (e.g. guests who don't have the sessionStorage key), the backend resolves location server-side via `ipapi.co/json/` using stdlib `urllib`. This is a last-resort safety net so web search always has a location.

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
    if debate_ended[0]:
        return  # stop cross-feeding after wrap-up
    now = time.monotonic()
    if vibe_state[0] != "speaking" and len(text) > 15 and (now - last_opt_bridge[0]) > BRIDGE_COOLDOWN:
        _safe_reply(vibe_session, f"[Optimizer just said]: {text}")
        last_opt_bridge[0] = now
# (mirror for vibe_session)
```
Agents never hear each other's audio. Instead, the transcript of each turn is injected into the other agent's context as a user message. `BRIDGE_COOLDOWN = 4.0` seconds prevents rapid back-and-forth echo loops. A 15-character minimum filters trivial turns. **The bridge is gated on `debate_ended[0]`** — once the wrap-up button is pressed, agents stop receiving each other's messages and go quiet naturally.

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
After a 2-second sleep (letting sessions connect), the Optimizer is seeded with the dilemma, location context, and participant names. The seed prompt tells the Optimizer to welcome participants by name, reference time/place, then **immediately pick one side of the dilemma and argue for it in one sharp sentence**. Vibe-Check reacts via the text bridge and must take the opposite side.

**System prompts — structure:**
Both agents have three key sections:
1. **CRITICAL (opening)**: Take a position immediately on the first turn — no meta-commentary about the debate.
2. **PRIORITY ORDER**: React to humans first (by name), co-host second.
3. **USE SEARCH RESULTS**: When given specific facts, names, stats, or details from a web search, state at least two specifics out loud by name — never paraphrase. Then ask the humans if any of it changes their thinking. This is intentionally generic (not "place names") so it works for food, tech, career, travel, or any dilemma type.
4. **CONVERGENCE**: Once humans lean toward one option, stop abstract debate and ask a specific follow-up question to finalize the decision.

Response length: 1-2 short sentences max.

**Wrap-up / consensus flow:**
When the user clicks "We've decided!" in the UI:
1. Frontend sends `{ type: "consensus" }` via data channel
2. Backend sets `debate_ended[0] = True` — stops orchestrator loop and text bridge
3. Optimizer is immediately prompted for a funny one-sentence final verdict
4. After 6 seconds (letting Optimizer finish speaking), Vibe-Check is prompted for a dramatic sign-off
5. After 10 more seconds (16s total from button press), both sessions are interrupted via `session.interrupt()` to fully silence audio

---

### Orchestrator loop (`orchestrator_loop`)

Runs every **10 seconds** after a **15-second** warm-up delay. Uses NVIDIA Nemotron (`nvidia/llama-3.1-nemotron-70b-instruct`) via OpenAI-compatible API. `max_tokens=200` keeps responses fast and focused.

**Actions:**
| Action | What happens |
|---|---|
| `continue` | No injection |
| `inject_search` | Injects Tavily results directly (raw titles + content, not summarized) into Optimizer; asks humans if it changes their thinking |
| `ask_user` | Sends question to Optimizer immediately; 3s later sends to Vibe as fallback |
| `push_consensus` | Tells Optimizer to wrap toward a verdict |
| `end_debate` | Tells both agents to give verdict + sign off; sets `debate_ended[0] = True` |

**JSON reliability:** Uses `re.search(r"\{[^{}]*\}", raw)` to extract the first JSON object from the response — handles cases where the model wraps output in prose or markdown fences. Defaults safely to `action = "continue"` if parsing fails.

> **Model history:** Previously used `nvidia/llama-3.3-nemotron-super-49b-v1` which returned `{}` on ~80% of calls causing multi-minute gaps in orchestration. Switched to `nvidia/llama-3.1-nemotron-70b-instruct` which is significantly more reliable for JSON-only output.

---

### Web search (`_run_web_search`)

Tavily search runs in a thread executor (sync client). Two parallel queries using the first 80 characters of the dilemma (not the full string, which produces terrible search queries):
- `"best {dilemma[:80]} near {location_hint}"` (omits location suffix if empty)
- `"top rated {dilemma[:80]} {location_hint}"`

Location hint: `parts[1]` from the location string (city at index 1 in `"Monday 9:42 PM, City, Country"`). Falls back to `parts[0]` if fewer than 3 parts.

**Auto-injection (no orchestrator decision needed):**
As soon as search results arrive, they are **automatically injected** into the Optimizer without waiting for the orchestrator to choose `inject_search`. The inject prompt tells the Optimizer to state at least two specific names/facts/details from the results out loud and ask the humans if any of it changes their thinking. The orchestrator can still inject again later via its own `inject_search` action, but results are never held back waiting for it.

Raw Tavily `title` + first 150 chars of `content` are passed directly to agents — the orchestrator is never asked to summarize them, which previously caused specific names and facts to be lost.

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

**Location resolution starts immediately on page load** via `useEffect`. By the time the user fills in the dilemma and clicks "Start the Debate", location is already resolved. Stored in `sessionStorage` as `lk-location-${roomName}` when the room is created. A small location hint (city, country) is shown below the form so the user can confirm it's correct.

**Flow:**
- Page loads → location resolution starts in background
- Submit → POST `/api/token` with `{ roomName, identity, dilemma, participants }`
- Caches `token`, `wsUrl`, `participants`, `dilemma`, and **`location`** in `sessionStorage` keyed by room name
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

**Location initialization (race-condition free):**
`locationCtx` state is initialized directly from `sessionStorage.getItem(`lk-location-${roomName}`)` on first render — already populated by the landing page. The location `useEffect` only runs if `locationCtx` is empty (guest path, where sessionStorage has no cached location).

**Dilemma initialization:**
`dilemma` state is initialized from `sessionStorage.getItem(`lk-dilemma-${roomName}`)` on first render.

**`RoomInner` — metadata router:**
- `status === "waiting"` → renders `WaitingRoom`
- Otherwise → renders `RoomContent`

**`WaitingRoom`:**
- Filters out agents via `AGENT_IDENTITIES = new Set(["optimizer", "vibe-check"])`.
- Host sees "Start Debate" button — **disabled and shows "Getting location…" until `locationCtx` is non-empty**
- Guests see "Waiting for host to start…"
- Known cosmetic issue: job worker participant also appears in the list (identity is dispatch-assigned, not in the blocklist). Fix: switch to allowlist `host-*` / `guest-*`.

**`RoomContent`:**
- Two `AgentCard` components (amber = Optimizer, fuchsia = Vibe-Check) with speaking pulse
- `BarVisualizer` (24 bars), `TranscriptPanel`, `ParticipantControls`, `RoomAudioRenderer`
- **"We've decided!" button** sends `{ type: "consensus" }` → triggers agent wrap-up sequence (see wrap-up flow above)

**Speaker name tapping (data channel):**
Users tap a name button → sends `{ type: "speaker", name: "Alice" }`. Backend notifies both agents so they address the speaker by name.

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

## Known issues / decisions log

| Issue | Resolution |
|---|---|
| `gemini-2.5-flash` throws 1008 | Use `gemini-2.0-flash-live-001` only |
| Gemini 1008 at ~9 min | Natural Gemini Live session time limit. Sessions auto-reconnect. `_safe_reply` guard handles errors during reconnect. |
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
| Orchestrator returned `{}` ~80% of calls with old model | Switched from `nvidia/llama-3.3-nemotron-super-49b-v1` to `nvidia/llama-3.1-nemotron-70b-instruct` |
| Orchestrator still occasionally returns `{}` | `re.search` JSON extraction handles prose wrapping. Defaults to `continue`. |
| `tavily-python` not in requirements.txt | Run `.venv/bin/pip install tavily-python` manually. |
| Location empty in backend logs | Fixed: location now resolved on landing page and cached in sessionStorage. Backend also has server-side IP fallback. |
| Wrap-up button didn't stop agents | Fixed: text bridge gated on `debate_ended`; both sessions interrupted 16s after button press. |
| Both agents triggered simultaneously on wrap-up | Fixed: Vibe-Check cue delayed 6s so Optimizer finishes verdict before Vibe reacts. |
| Agents never named specific places/facts from search | Fixed: search results auto-injected immediately after fetch; raw Tavily data passed directly (not summarized). |
| Search injection prompts were food-specific ("place names") | Fixed: prompts now say "specific names, facts, or details" — generic for any dilemma type. |
| Full dilemma string used in search queries | Fixed: truncated to 80 chars to avoid garbage search queries. |

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

Open `http://localhost:3000`, enter a dilemma, add participant names, share the QR, then enter the room. All participants join the waiting room first; host clicks "Start Debate" to launch the agents. Location is detected automatically — the form shows the detected city/country so you can confirm it's correct before starting.
