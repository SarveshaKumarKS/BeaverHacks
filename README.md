# The Decider

**Two AI voices. Opposing perspectives. Your group makes the final call.**

The Decider is a voice based AI application that helps groups work through everyday decisions. Two AI agents debate the options, respond to participants, and bring different perspectives into a shared conversation.

Instead of asking a chatbot for another list of recommendations, participants can speak with both agents, challenge their reasoning, and guide the discussion toward a decision.

> Example: “Should we get dinner downtown or have a picnic?”

The Optimizer argues from practical considerations. The Vibe Check argues from preferences, atmosphere, and the experience people want. An optional background orchestrator introduces web search results and helps keep the conversation moving.

## What you can do

1. Create a room with a dilemma and participant names.
2. Share the room through a link or QR code.
3. Start a live discussion between two AI voice agents.
4. Speak to the agents through the host’s microphone and follow the live transcript.
5. Signal agreement to trigger closing remarks and end the debate.

The current demo is designed around people sharing the host’s microphone. Participants tap their name before speaking so the agents receive speaker context.

## How it works

### Two conversational agents

Both agents use Gemini Live through separate LiveKit sessions and publish audio as distinct room participants.

**The Optimizer** takes a logical, direct approach and argues for practical choices.

**The Vibe Check** takes an expressive approach and challenges the Optimizer from a different perspective.

The agents receive each other’s contributions through a transcript bridge rather than by listening to each other’s audio.

### A silent orchestrator

An optional NVIDIA Nemotron agent reviews the dilemma, recent transcript, location context, and available search results.

It can choose to let the conversation continue, introduce search findings, request human input, encourage agreement, or initiate closing remarks.

Orchestration messages are queued for delivery at conversation boundaries rather than injected indiscriminately while an agent is speaking.

### Conversation controls

The implementation includes speaking state checks, interruption handling, and alternation controls to reduce overlapping speech and repeated turns.

Transcript bridging uses cooldowns and echo checks to limit repetitive exchanges. Duplicate human transcription events are filtered, and direct questions are subject to a cooldown.

Participants can signal consensus through the interface. That signal stops further debate bridging and triggers a closing sequence.

### Web context

Optional Tavily searches retrieve information related to the dilemma and location. Search results are passed to the orchestrator for possible introduction into the conversation.

The interface resolves location before starting the debate, with fallback behavior when browser location is unavailable.

## Technology

**Frontend:** Next.js, React, TypeScript, Tailwind CSS, and LiveKit React components.

**Voice infrastructure:** LiveKit rooms, audio tracks, transcription events, and data messages.

**Agent runtime:** Python, LiveKit Agents, and Gemini Live.

**Optional orchestration:** NVIDIA Nemotron through NVIDIA’s API.

**Optional search:** Tavily.

The backend runs as a LiveKit worker. It is not the FastAPI and Socket.IO server described in the project’s earlier README.

## Run locally

The project context identifies `Livekit` as the active development branch. These instructions target that implementation.

### 1. Clone the repository

```bash
git clone --branch Livekit https://github.com/SarveshaKumarKS/BeaverHacks.git
cd BeaverHacks
```

You will need Python, Node.js with npm, LiveKit credentials, and a Gemini API key with access to a compatible Live model.

NVIDIA and Tavily credentials are optional.

### 2. Set up the backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
```

Edit `backend/.env`:

```dotenv
GEMINI_API_KEY=your_gemini_api_key
GEMINI_LIVE_MODEL=gemini-2.0-flash-live-001

LIVEKIT_URL=wss://your_livekit_project_url
LIVEKIT_API_KEY=your_livekit_api_key
LIVEKIT_API_SECRET=your_livekit_api_secret

NVIDIA_API_KEY=
NVIDIA_NEMOTRON_MODEL=nvidia/llama-3.1-nemotron-70b-instruct
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1

TAVILY_API_KEY=
```

The model identifiers above are the repository defaults. Confirm that the configured models are available to your account. The voice model must support Gemini Live.

Set `NVIDIA_API_KEY` to enable the background orchestrator. Set `TAVILY_API_KEY` to enable search. Configure both for orchestration that incorporates search results.

Leave unused optional keys empty rather than retaining placeholder text.

Start the worker:

```bash
python agent.py dev
```

Keep this terminal running.

### 3. Set up the frontend

In a second terminal, from the repository root:

```bash
cd frontend
npm install
cp .env.example .env.local
```

Edit `frontend/.env.local` using the same LiveKit project as the backend:

```dotenv
NEXT_PUBLIC_LIVEKIT_URL=wss://your_livekit_project_url

LIVEKIT_URL=wss://your_livekit_project_url
LIVEKIT_API_KEY=your_livekit_api_key
LIVEKIT_API_SECRET=your_livekit_api_secret
```

Only the public LiveKit URL belongs in a variable beginning with `NEXT_PUBLIC_`. Keep API credentials in the server environment.

Start the frontend:

```bash
npm run dev
```

Open `http://localhost:3000`.

### 4. Try a conversation

Enter a dilemma and participant names, create a room, and allow microphone access on the host device.

Start the debate once the room is ready. Tap a participant’s name before speaking, respond to the agents, and use the agreement control when the group has decided.

For guests joining from another device, use a frontend address that their device can reach. A link containing `localhost` points to the guest’s own device, not the host’s computer.

## Project structure

```text
backend/
    agent.py
    requirements.txt
    .env.example

frontend/
    src/app/page.tsx
    src/app/room/[session_id]/page.tsx
    src/app/api/token/route.ts
    src/app/api/start/route.ts
    .env.example
    netlify.toml
    package.json

context.md
```

`backend/agent.py` contains the voice sessions, transcript bridge, conversation controls, search integration, and orchestration loop.

The frontend provides the lobby, room interface, transcript, speaker selection, and agreement control. Its API routes issue room access tokens and signal the start of a debate.

`context.md` contains additional implementation notes. Some notes describe earlier iterations, so consult the corresponding code when details differ.

## Deployment

The frontend includes Netlify configuration for Next.js.

The Python worker runs separately and connects to LiveKit. Deploying the frontend alone does not start the agents.

Configure the frontend and worker with matching LiveKit credentials, and keep credentials out of committed files.

## Prototype limitations

The current interaction is designed around a shared host microphone, not independent microphone input from every remote participant.

Conversation controls reduce overlapping speech and repetitive exchanges, but they do not guarantee that every debate will converge.

Search and orchestration depend on optional services and credentials. Retrieved information and agent statements should not be treated as verified conclusions.

The application supports a group’s decision. It does not replace the group’s judgment.
