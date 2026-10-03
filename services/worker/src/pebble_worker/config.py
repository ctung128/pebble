"""Worker settings. Loopback-only by construction: any other host is refused."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from .errors import ConfigError

LOOPBACK_HOST = "127.0.0.1"
# Not 8765: that's AnkiConnect's default, and Pebble users often run Anki.
DEFAULT_PORT = 8790
# Vite dev (5173), local-mode dev (5175) and preview (4173), by name and by address.
DEFAULT_ORIGINS: tuple[str, ...] = tuple(
    f"http://{host}:{port}" for port in (5173, 5175, 4173) for host in ("localhost", "127.0.0.1")
)
ALLOWED_HOST_NAMES: tuple[str, ...] = ("127.0.0.1", "localhost")
_LOCAL_ORIGIN = re.compile(r"^http://(localhost|127\.0\.0\.1):\d{1,5}$")


@dataclass(frozen=True)
class ChunkingConfig:
    """Silence-aware chunking. Cuts at the silence closest to `target`, within [min, max]."""

    target_seconds: float = 150.0
    min_seconds: float = 120.0
    max_seconds: float = 240.0
    silence_min_seconds: float = 0.4
    silence_noise_db: float = -35.0

    def __post_init__(self) -> None:
        if not 0 < self.min_seconds <= self.target_seconds <= self.max_seconds:
            raise ConfigError("Chunking requires 0 < min <= target <= max seconds.")
        if self.silence_min_seconds <= 0:
            raise ConfigError("Silence duration must be positive.")


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    host: str = LOOPBACK_HOST
    port: int = DEFAULT_PORT
    allowed_origins: tuple[str, ...] = DEFAULT_ORIGINS
    chunking: ChunkingConfig = field(default_factory=ChunkingConfig)
    max_audio_seconds: float = 4 * 3600
    max_upload_bytes: int = 2 * 1024**3
    ffmpeg_path: str = "ffmpeg"
    ffprobe_path: str = "ffprobe"
    mock_delay_ms: int = 300
    #: 1-based chunk number at which the mock provider fails (for testing failures).
    mock_fail_at_chunk: int | None = None

    def __post_init__(self) -> None:
        if self.host != LOOPBACK_HOST:
            raise ConfigError(
                f"Refusing to bind to {self.host!r}. The Pebble worker only listens on "
                f"{LOOPBACK_HOST} so private audio never leaves this computer."
            )
        if not 1 <= self.port <= 65535:
            raise ConfigError(f"Invalid port {self.port}.")
        for origin in self.allowed_origins:
            if not _LOCAL_ORIGIN.match(origin):
                raise ConfigError(
                    f"Allowed origin {origin!r} is not a local http origin "
                    "(http://localhost:PORT or http://127.0.0.1:PORT)."
                )
        if self.max_upload_bytes <= 0 or self.max_audio_seconds <= 0:
            raise ConfigError("Upload and duration limits must be positive.")

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None, **overrides: object) -> Settings:
        env = os.environ if env is None else env

        def num(name: str, default: float) -> float:
            raw = env.get(name)
            if raw is None or raw == "":
                return default
            try:
                return float(raw)
            except ValueError as error:
                raise ConfigError(f"{name} must be a number, got {raw!r}.") from error

        fail_at = env.get("PEBBLE_MOCK_FAIL_AT_CHUNK")
        values: dict[str, object] = {
            "data_dir": Path(env.get("PEBBLE_DATA_DIR") or "~/.pebble").expanduser(),
            "host": env.get("PEBBLE_HOST") or LOOPBACK_HOST,
            "port": int(num("PEBBLE_PORT", DEFAULT_PORT)),
            "allowed_origins": tuple(
                o.strip() for o in env["PEBBLE_ALLOWED_ORIGINS"].split(",") if o.strip()
            )
            if env.get("PEBBLE_ALLOWED_ORIGINS")
            else DEFAULT_ORIGINS,
            "chunking": ChunkingConfig(
                target_seconds=num("PEBBLE_CHUNK_TARGET_SECONDS", 150),
                min_seconds=num("PEBBLE_CHUNK_MIN_SECONDS", 120),
                max_seconds=num("PEBBLE_CHUNK_MAX_SECONDS", 240),
                silence_min_seconds=num("PEBBLE_SILENCE_MIN_SECONDS", 0.4),
                silence_noise_db=num("PEBBLE_SILENCE_NOISE_DB", -35),
            ),
            "max_audio_seconds": num("PEBBLE_MAX_AUDIO_SECONDS", 4 * 3600),
            "max_upload_bytes": int(num("PEBBLE_MAX_UPLOAD_MB", 2048) * 1024 * 1024),
            "ffmpeg_path": env.get("PEBBLE_FFMPEG") or "ffmpeg",
            "ffprobe_path": env.get("PEBBLE_FFPROBE") or "ffprobe",
            "mock_delay_ms": int(num("PEBBLE_MOCK_DELAY_MS", 300)),
            "mock_fail_at_chunk": int(fail_at) if fail_at else None,
        }
        values.update(overrides)
        return cls(**values)  # type: ignore[arg-type]
