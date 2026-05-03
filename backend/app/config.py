from __future__ import annotations

from pydantic import Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    gemini_api_key: str = Field(alias="GEMINI_API_KEY")
    nvidia_api_key: str = Field(alias="NVIDIA_API_KEY")
    gemini_model: str = Field(default="gemini-1.5-flash", alias="GEMINI_MODEL")
    nvidia_nemotron_model: str = Field(
        default="nvidia/nemotron-3-super-120b-a12b",
        alias="NVIDIA_NEMOTRON_MODEL",
    )
    nvidia_orchestrator_model: str = Field(
        default="nvidia/llama-3.3-nemotron-super-49b-v1",
        alias="NVIDIA_ORCHESTRATOR_MODEL",
    )
    nvidia_base_url: str = Field(
        default="https://integrate.api.nvidia.com/v1",
        alias="NVIDIA_BASE_URL",
    )
    frontend_origin: str = Field(default="http://localhost:3000", alias="FRONTEND_ORIGIN")
    # Optional: set to enable provider TTS via the /tts endpoint
    openai_api_key: str | None = Field(default=None, alias="OPENAI_API_KEY")

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


def load_settings() -> Settings:
    try:
        return Settings()
    except ValidationError as exc:
        missing = [
            ".".join(str(part) for part in error["loc"])
            for error in exc.errors()
            if error["type"] == "missing"
        ]
        names = ", ".join(missing) if missing else "required environment variables"
        raise RuntimeError(
            f"Missing backend credentials/config: {names}. Copy backend/.env.example to "
            "backend/.env and fill in real Gemini and NVIDIA values."
        ) from exc
