import asyncio

import pytest

from app.orchestration import SessionManager


class FakeLLM:
    def __init__(self, responses):
        self.responses = responses

    async def stream_agent(self, agent, session, force=False):
        text = self.responses.pop(0)
        for chunk in text.split(" "):
            yield chunk + " "


async def collect(event, payload, room):
    collect.events.append((event, payload, room))


collect.events = []


@pytest.mark.asyncio
async def test_loop_pauses_for_interrogation(tmp_path, monkeypatch):
    collect.events = []
    manager = SessionManager(FakeLLM(["[INTERROGATE: budget] Name the money."]))
    session = await manager.create_session("group", "What should we eat?")
    await manager._debate_loop(session.session_id, collect)
    assert session.status == "paused_for_interrogation"
    assert any(event[0] == "interrogation_triggered" for event in collect.events)


@pytest.mark.asyncio
async def test_interjection_resets_turn(monkeypatch):
    collect.events = []
    manager = SessionManager(FakeLLM(["[INTERROGATE: budget] Name the money."]))
    session = await manager.create_session("group-2", "Dinner?")
    session.current_turn = 3
    await manager.handle_interjection(session.session_id, "Budget is $40", collect)
    await asyncio.sleep(0)
    assert session.current_turn in (0, 1)
    assert session.known_constraints["budget"] == "$40"
    await manager.cancel_loop(session.session_id)
