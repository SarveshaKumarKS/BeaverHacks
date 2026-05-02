# The Consensus Duo

Real-time multi-agent debate app for resolving group decision fatigue.

## Apps

- `backend/`: FastAPI + python-socketio API and AI orchestration.
- `frontend/`: Next.js App Router client.

## Backend Setup

```bash
cd backend
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Fill in:

- `GEMINI_API_KEY`
- `NVIDIA_API_KEY`
- `GEMINI_MODEL`
- `NVIDIA_NEMOTRON_MODEL`

Then run:

```bash
uvicorn app.main:socket_app --reload --host 0.0.0.0 --port 8000
```

## Frontend Setup

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

## Tests

```bash
cd backend
pytest
```
