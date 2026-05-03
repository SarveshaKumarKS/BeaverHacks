# The Decider — Livekit Branch Codebase Context

> Read this before touching any code. It covers architecture, every file that matters, all env vars, known gotchas, and the decisions behind them.

---

## What the app does

Two AI voice agents ("The Optimizer" and "The Vibe-Check") debate the user's dilemma in real-time audio inside a shared LiveKit room. Multiple humans join via QR code and share the host's microphone to speak to the agents. A live transcript is rendered in the browser.

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
- **Frontend** is deployed on Netlify. Uses `@netlify/plugin-nextjs` (in `netlify.toml`) to handle dynamic routes and API routes.

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
GEMINI_LIVE_MODEL=gemini-2.0-flash-live-001   # MUST be this — gemini-2.5-flash does NOT support bidiGenerateContent
LIVEKIT_URL=wss://beavorhack-28w72ye0.livekit.cloud
LIVEKIT_API_KEY=<your LiveKit API key>
LIVEKIT_API_SECRET=<your LiveKit API secret>
```

> **Critical:** `GEMINI_LIVE_MODEL` must be `gemini-2.0-flash-live-001`. Models like `gemini-2.5-flash` do not support the Gemini Live (bidiGenerateContent) API and will throw a 1008 policy violation error.

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
Room metadata is initialised as `{ dilemma: "...", status: "waiting" }` when the room is created. The backend worker polls `ctx.room.metadata` every 0.5s. When the host clicks "Start Debate", the frontend POSTs to `/api/start` which calls `RoomServiceClient.updateRoomMetadata(roomName, { dilemma, status: "started" })`. The worker detects the change and proceeds to connect both agent rooms and start sessions.

**Multi-speaker design:**
Gemini Live API accepts only a single audio stream, so only the host's microphone audio reaches the agents (fundamental API constraint). The workaround for group use: guests physically gather around the host's device and take turns speaking into its mic. The agents are prompted to detect voice changes naturally — no diarization, zero latency overhead.

**Turn-taking guard:**
```python
@optimizer_session.on("agent_state_changed")
def _opt_state(ev):
    if ev.new_state == "speaking":
        vibe_session.interrupt()
# (mirror for vibe_session)
```
When one agent starts speaking, it immediately calls `interrupt()` on the other.

**Text bridge:**
```python
@optimizer_session.on("conversation_item_added")
def _opt_item(ev):
    # fires when Optimizer finishes a turn
    vibe_session.generate_reply(user_input=f"[Optimizer just said]: {text}")
# (mirror for vibe_session)
```
Agents never hear each other's audio. Instead, the transcript of each turn is injected into the other agent's context as a user message.

**Debate seeding:**
After a 2-second sleep (letting sessions connect), the Optimizer is seeded with the dilemma and the participant count from `ctx.room.metadata`. Vibe-Check reacts via the text bridge.

**Agent system prompts — multi-speaker awareness:**
Both prompts tell the agents that multiple people may speak into one microphone and instruct them to react naturally to voice changes:
- Optimizer: `"oh wait, new voice — what do you think?"`
- Vibe-Check: `"wait, is that someone new? hi! spill."`
No diarization or STT pipeline is used — Gemini Live can perceive different voices in the audio stream directly.

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
Do NOT use `@import "@livekit/components-styles"` in CSS files. The package's `exports` field does not expose the package root (`.`), so webpack throws `Package path . is not exported`. The correct import is in `layout.tsx`:
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

1. **Form view** (default): textarea for the dilemma + "Start the Debate" button.
2. **Lobby view** (after submit): shown when `shareUrl !== ""`. Displays a 320×320 QR code, copyable share URL, and an "Enter Room" button. The user stays here to let others scan the QR before entering.

**Flow:**
- Submit → POST `/api/token` with `{ roomName, identity, dilemma }`
- Caches `token` and `wsUrl` in `sessionStorage` keyed by `lk-token-${roomName}` and `lk-wsurl-${roomName}`
- Generates QR data URL via `qrcode` library (dark-themed, 320px)
- Sets state → renders lobby view (no navigation yet)
- User clicks "Enter Room" → `router.push(/room/${roomName})`

### `src/app/api/token/route.ts` — Token API

**POST** `/api/token` — host flow:
- Body: `{ roomName, identity, dilemma }`
- Creates the LiveKit room with metadata `{ dilemma, status: "waiting" }` via `RoomServiceClient.createRoom()`
- The dilemma + status are stored as room metadata — `agent.py` reads them via `ctx.room.metadata`
- Returns `{ token, wsUrl, roomName }`

**GET** `/api/token?room=<name>&identity=<id>` — guest flow:
- Returns a fresh participant JWT for guests joining via QR code
- Identity defaults to `guest-${Date.now()}` if not provided

### `src/app/api/start/route.ts` — Start Signal API

**POST** `/api/start`:
- Body: `{ roomName, dilemma }`
- Calls `RoomServiceClient.updateRoomMetadata(roomName, { dilemma, status: "started" })`
- Backend worker detects this change and launches both agent sessions
- Returns `{ ok: true }`

### `src/app/room/[session_id]/page.tsx` — Live Room

**Token resolution:**
- Host: reads cached token from `sessionStorage` (set by landing page)
- Guest: fetches via GET `/api/token?room=...`

**`RoomInner` — metadata router:**
- Reads room metadata via `useRoomContext()` + `"roomMetadataChanged"` event
- If `status === "waiting"`: renders `WaitingRoom`
- Otherwise: renders `RoomContent`

**`WaitingRoom`:**
- Lists human participants only — filters using `AGENT_IDENTITIES = new Set(["optimizer", "vibe-check"])`.
  > **Note:** The job worker (`ctx.room` connection) also appears here because its dispatch-assigned identity doesn't match either filter entry. Known cosmetic issue; fix is to change the filter to an allowlist: `p.identity.startsWith("host-") || p.identity.startsWith("guest-")`.
- Host (`identity.startsWith("host-")`) sees a "Start Debate" button — clicking it POSTs to `/api/start`
- Guests see "Waiting for host to start…"

**`RoomContent` — main UI inside the LiveKit context:**
- Renders two `AgentCard` components (amber ring for Optimizer, fuchsia for Vibe-Check) with speaking pulse indicator
- Renders `BarVisualizer` (24 bars, audio track from `useVoiceAssistant()`)
- Renders `TranscriptPanel`
- Renders `ParticipantControls` (mic toggle + leave button)
- Renders `RoomAudioRenderer` (makes agent audio audible)

**`ParticipantControls`:**
- Replaces `VoiceAssistantControlBar` (which required a voice assistant session)
- Uses `useLocalParticipant()` and calls `setMicrophoneEnabled(true)` on mount so mic is on by default
- Renders a toggle mic button + leave button

**`TranscriptPanel` + `useTranscript` hook:**
- Listens to `room.on("transcriptionReceived", ...)` — fired by LiveKit for both agent TTS and human STT
- Merges non-final (streaming) segments in-place by segment `id`; text dims to 50% opacity until `final: true`
- Auto-scrolls to bottom via `bottomRef`
- Hidden until first line arrives

**`speakerName(participant, localIdentity)`:**
- `participant.identity === localIdentity` → `"You"` (local human)
- `identity === "optimizer"` → `"The Optimizer"`
- `identity === "vibe-check"` → `"The Vibe-Check"`
- anything else → `participant.identity` (guest users shown by their raw identity, emerald color)

**`QRButton` — "Invite" button in the header:**
- Generates QR data URL once on mount (200px, dark-themed)
- Toggles a popover on click showing the QR with "Scan to join" label
- Share link also available via "Share" copy button next to it

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

Required Netlify environment variables (set in Netlify dashboard):
```
LIVEKIT_URL=wss://beavorhack-28w72ye0.livekit.cloud
LIVEKIT_API_KEY=<key>
LIVEKIT_API_SECRET=<secret>
```

The `@netlify/plugin-nextjs` package is in `devDependencies` in `package.json`. It is required for dynamic routes (`/room/[session_id]`) and API routes (`/api/token`, `/api/start`) to work on Netlify.

---

## Known issues / decisions log

| Issue | Resolution |
|---|---|
| `gemini-2.5-flash` throws 1008 | Use `gemini-2.0-flash-live-001` only |
| `livekit-server-sdk` pip package doesn't exist | Token generation stays in Next.js; Python uses `livekit-api` (auto-installed) |
| `@import "@livekit/components-styles"` breaks webpack | Import via JS in `layout.tsx` using `@livekit/components-styles/index.css` |
| Both agents labeled "You" in transcript | Agent identities must be explicit: `"optimizer"` and `"vibe-check"` via `_make_agent_token` |
| `onConnected` callback on `<LiveKitRoom>` doesn't receive `Room` arg | Read metadata inside `RoomContent` via `useRoomContext()` + `"roomMetadataChanged"` event |
| `RoomOptions` import fails | Use `RoomInputOptions` — the deprecation warning message is wrong, `RoomOptions` doesn't exist in v1.5.7 |
| `transcriptionReceived` participant arg is `Participant \| undefined` | Guard with `if (!participant) return` before using it |
| Hydration mismatch from Dark Reader extension | `suppressHydrationWarning` on `<html>` in `layout.tsx` |
| QR flash on landing — user couldn't see it | Removed `router.push` from submit handler; added explicit lobby view with "Enter Room" button |
| Guest mic was always muted | Replaced `VoiceAssistantControlBar` with `ParticipantControls` using `useLocalParticipant()` + `setMicrophoneEnabled(true)` on mount |
| Agents only hear the first participant to join | Gemini Live API accepts a single audio stream — `AgentSession` wires only ONE participant's audio to Gemini. Accepted as demo limitation. Workaround: waiting room ensures all participants join before `session.start()`, but only the first participant's audio is processed by Gemini |
| Agents unaware multiple people share one mic | Updated system prompts to tell agents multiple voices may come from one mic and to react naturally to voice changes (zero latency, no diarization) |
| Job worker participant appears in waiting room list | `ctx.room` connects with a dispatch-assigned identity that doesn't match `AGENT_IDENTITIES`. Fix: change filter to allowlist `host-*` / `guest-*` identities instead of blocklist |

---

## Running locally (full stack)

```bash
# Terminal 1 — backend
cd backend
cp .env.example .env   # fill in real keys
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python agent.py dev

# Terminal 2 — frontend
cd frontend
cp .env.example .env.local   # fill in real keys
npm install
npm run dev
```

Open `http://localhost:3000`, enter a dilemma, share the QR, then enter the room. All participants join the waiting room first; host clicks "Start Debate" to launch the agents.
