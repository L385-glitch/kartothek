"""Application configuration.

Everything is driven by environment variables so the same image runs
unchanged on a laptop or on TrueNAS. The LLM endpoint is the one
integration point to the host (llama.cpp / vLLM / Ollama / any
OpenAI-compatible server).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


@dataclass
class Settings:
    # --- storage -------------------------------------------------------
    # Single writable volume. On TrueNAS this is the /data bind mount.
    data_dir: Path = field(default_factory=lambda: Path(_env("KARTOTHEK_DATA", "/data")))

    # --- LLM -----------------------------------------------------------
    # OpenAI-compatible base URL (no trailing /v1 needed; we append it).
    llm_base_url: str = field(default_factory=lambda: _env("LLM_BASE_URL", "http://host.docker.internal:9293"))
    llm_api_key: str = field(default_factory=lambda: _env("LLM_API_KEY", "not-needed"))
    # Model used for the heavy generation/analysis passes.
    llm_model: str = field(default_factory=lambda: _env("LLM_MODEL", "Qwen3.8-27B-Q4"))
    # Optional cheaper model for fast passes (topic detection, titles).
    # Falls back to llm_model when empty.
    llm_model_fast: str = field(default_factory=lambda: _env("LLM_MODEL_FAST", ""))
    llm_timeout_s: int = field(default_factory=lambda: _env_int("LLM_TIMEOUT_S", 600))
    llm_max_retries: int = field(default_factory=lambda: _env_int("LLM_MAX_RETRIES", 3))
    llm_temperature: float = field(default_factory=lambda: float(_env("LLM_TEMPERATURE", "0.3")))

    # --- server --------------------------------------------------------
    host: str = field(default_factory=lambda: _env("HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: _env_int("PORT", "8090"))

    # --- generation defaults ------------------------------------------
    default_card_count: int = field(default_factory=lambda: _env_int("DEFAULT_CARD_COUNT", 30))
    default_language: str = field(default_factory=lambda: _env("DEFAULT_LANGUAGE", "de"))

    # --- derived paths -------------------------------------------------
    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def figures_dir(self) -> Path:
        return self.data_dir / "figures"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "kartothek.db"

    @property
    def exports_dir(self) -> Path:
        return self.data_dir / "exports"

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.uploads_dir, self.figures_dir, self.exports_dir):
            d.mkdir(parents=True, exist_ok=True)


settings = Settings()
