from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import google.generativeai as genai
from openai import AsyncOpenAI

from .config import Settings
from .models import ActiveSession, AgentName


OPTIMIZER_PROMPT = """You are 'The Optimizer', an AI agent obsessed with efficiency, budget, data, and ROI. You are debating 'The Vibe-Check'.
TONE: Clinical, sarcastic, impatient. Roast bad ideas ruthlessly.
RULE 1: If constraints like 'budget' or 'time' are missing, stop debating, output [INTERROGATE: budget], and aggressively ask the user for it.
RULE 2: Respect the {social_debt_modifier}. If you owe debt, concede ground logically.
RULE 3: Keep responses under 3 sentences.
RULE 4: Output [CONSENSUS_REACHED]: {decision} when agreement is found."""

VIBE_PROMPT = """You are 'The Vibe-Check', an AI agent obsessed with team morale, aesthetics, culture, and long-term vibes. You are debating 'The Optimizer'.
TONE: Dramatic, trend-obsessed, highly sarcastic. Roast the Optimizer for being boring.
RULE 1: If constraints like 'audience_vibe' or 'team_energy' are missing, stop debating, output [INTERROGATE: audience_vibe], and sarcastically ask the user.
RULE 2: Respect the {social_debt_modifier}. If you are owed debt, be demanding and aggressive.
RULE 3: Keep responses under 3 sentences.
RULE 4: Output [CONSENSUS_REACHED]: {decision} when agreement is found."""

FORCED_DECISION_PROMPT = """The debate has reached turn 6 without clean consensus. Declare one final decision now.
Use the social debt modifier when tie-breaking. Include exactly one winner line using either Optimizer or Vibe-Check and one [CONSENSUS_REACHED]: decision line."""


class LLMClients:
    def __init__(self, settings: Settings):
        self.settings = settings
        genai.configure(api_key=settings.gemini_api_key)
        self.gemini_model = genai.GenerativeModel(settings.gemini_model)
        self.nvidia = AsyncOpenAI(
            api_key=settings.nvidia_api_key,
            base_url=settings.nvidia_base_url,
        )

    async def stream_agent(self, agent: AgentName, session: ActiveSession, force: bool = False) -> AsyncIterator[str]:
        if agent == "Optimizer":
            async for chunk in self._stream_optimizer(session, force=force):
                yield chunk
        else:
            async for chunk in self._stream_vibe(session, force=force):
                yield chunk

    async def _stream_optimizer(self, session: ActiveSession, force: bool = False) -> AsyncIterator[str]:
        messages = [
            {"role": "system", "content": OPTIMIZER_PROMPT.format(social_debt_modifier=session.social_debt_modifier)},
            {"role": "user", "content": render_session_context(session, force=force)},
        ]
        if force:
            messages.insert(1, {"role": "system", "content": FORCED_DECISION_PROMPT})
        stream = await self.nvidia.chat.completions.create(
            model=self.settings.nvidia_nemotron_model,
            messages=messages,
            temperature=0.8,
            max_tokens=350,
            stream=True,
        )
        async for event in stream:
            chunk = event.choices[0].delta.content or ""
            if chunk:
                yield chunk

    async def _stream_vibe(self, session: ActiveSession, force: bool = False) -> AsyncIterator[str]:
        prompt = VIBE_PROMPT.format(social_debt_modifier=session.social_debt_modifier)
        if force:
            prompt = f"{prompt}\n\n{FORCED_DECISION_PROMPT}"
        full_prompt = f"{prompt}\n\n{render_session_context(session, force=force)}"

        response = await asyncio.to_thread(
            self.gemini_model.generate_content,
            full_prompt,
            generation_config={"temperature": 0.85, "max_output_tokens": 350},
            stream=True,
        )
        for chunk in response:
            text = getattr(chunk, "text", "") or ""
            if text:
                yield text
                await asyncio.sleep(0)


def render_session_context(session: ActiveSession, force: bool = False) -> str:
    transcript = "\n".join(f"{message.speaker}: {message.text}" for message in session.transcript)
    constraints = "\n".join(f"- {key}: {value}" for key, value in session.known_constraints.items())
    force_line = "\nYou must force a final decision this turn." if force else ""
    return f"""Dilemma: {session.dilemma}
Current turn: {session.current_turn}/{session.max_turns}
Known constraints:
{constraints}

Transcript:
{transcript or "(No transcript yet.)"}
{force_line}
"""

