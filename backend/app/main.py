from __future__ import annotations

import socketio
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from .config import load_settings
from .llm import LLMClients
from .models import CreateRoomPayload, JoinRoomPayload, UserInterjectionPayload
from .orchestration import SessionManager

settings = load_settings()
fastapi_app = FastAPI(title="The Consensus Duo API")
fastapi_app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin, "http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins=[settings.frontend_origin, "http://localhost:3000", "http://127.0.0.1:3000"],
)
llm = LLMClients(settings)
manager = SessionManager(llm)


async def emit(event: str, payload: dict, room: str | None = None) -> None:
    await sio.emit(event, payload, room=room)


@fastapi_app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@fastapi_app.get("/sessions/{session_id}")
async def get_session(session_id: str) -> dict:
    session = manager.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session.model_dump(mode="json")


@fastapi_app.get("/tts/available")
async def tts_available() -> dict[str, bool]:
    return {"available": settings.openai_api_key is not None}


@fastapi_app.post("/tts")
async def tts_endpoint(agent: str = "Optimizer", text: str = "") -> Response:
    """Convert text to speech using OpenAI TTS. Requires OPENAI_API_KEY."""
    if not settings.openai_api_key:
        raise HTTPException(status_code=404, detail="TTS not configured (set OPENAI_API_KEY)")
    if not text.strip():
        raise HTTPException(status_code=400, detail="text is required")

    audio_bytes = await llm.text_to_speech(agent, text.strip())  # type: ignore[arg-type]
    if audio_bytes is None:
        raise HTTPException(status_code=500, detail="TTS generation failed")

    return Response(content=audio_bytes, media_type="audio/mpeg")


@sio.event
async def connect(sid: str, environ: dict, auth: dict | None = None) -> None:
    await sio.emit("connected", {"sid": sid}, room=sid)


@sio.event
async def disconnect(sid: str) -> None:
    return None


@sio.event
async def create_room(sid: str, payload: dict) -> dict:
    parsed = CreateRoomPayload.model_validate(payload)
    session = await manager.create_session(parsed.group_id, parsed.initial_dilemma)
    await sio.enter_room(sid, session.session_id)
    await emit("room_state_update", session.model_dump(mode="json"), session.session_id)
    await manager.start_loop(session.session_id, emit)
    return {"session_id": session.session_id}


@sio.event
async def join_room(sid: str, payload: dict) -> dict:
    parsed = JoinRoomPayload.model_validate(payload)
    session = manager.get(parsed.session_id)
    if not session:
        return {"ok": False, "error": "Session not found"}
    await sio.enter_room(sid, parsed.session_id)
    await emit("room_state_update", session.model_dump(mode="json"), parsed.session_id)
    return {"ok": True}


@sio.event
async def user_interjection(sid: str, payload: dict) -> dict:
    parsed = UserInterjectionPayload.model_validate(payload)
    session = await manager.handle_interjection(parsed.session_id, parsed.text, emit)
    if not session:
        return {"ok": False, "error": "Session not found"}
    return {"ok": True}


socket_app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)
