"""
Worker health: tools, data directory and providers. The data directory's location is the only
path reported (abbreviated with "~"), so the local app can explain setup problems.
"""

from __future__ import annotations

import os
from pathlib import Path

from . import __version__
from .config import Settings
from .contract import CURRENT_SCHEMA_VERSION, SpeakerHealth, TranslationHealth, WorkerHealth
from .pipeline.tools import tool_version
from .providers.base import TranscriptionProvider
from .storage import Storage


def check_health(
    settings: Settings,
    storage: Storage,
    providers: list[TranscriptionProvider],
    translation: TranslationHealth | None = None,
    speakers: SpeakerHealth | None = None,
) -> WorkerHealth:
    """
    `translation` (ADR 0008) and `speakers` (ADR 0009) are reported only when given. Neither
    affects `status`: missing speaker weights or sandbox never degrade transcription or English.
    """
    ffmpeg = tool_version(settings.ffmpeg_path)
    ffprobe = tool_version(settings.ffprobe_path)
    writable = storage.root.is_dir() and os.access(storage.root, os.W_OK)
    provider_status = [{"id": p.id, "kind": p.kind, **_health(p)} for p in providers]
    ok = (
        ffmpeg is not None
        and ffprobe is not None
        and writable
        and all(p["available"] for p in provider_status)
    )
    return WorkerHealth.model_validate(
        {
            "schemaVersion": CURRENT_SCHEMA_VERSION,
            "workerVersion": __version__,
            "status": "ok" if ok else "degraded",
            "dataDirWritable": writable,
            "dataDir": {
                "path": display_path(storage.root),
                "writable": writable,
                "hint": None
                if writable
                else "Check that this folder exists and you can write to it, or choose another "
                "location with PEBBLE_DATA_DIR, then restart the worker.",
            },
            "tools": {
                "ffmpeg": {"available": ffmpeg is not None, "version": ffmpeg},
                "ffprobe": {"available": ffprobe is not None, "version": ffprobe},
            },
            "providers": provider_status,
            **({"instanceId": settings.instance_id} if settings.instance_id else {}),
            **({"translation": translation.dump()} if translation else {}),
            **({"speakers": speakers.dump()} if speakers else {}),
        }
    )


def _health(provider: TranscriptionProvider) -> dict[str, object]:
    health = provider.health()
    return {
        "available": health.available,
        "detail": health.detail,
        "state": health.state,
        "hint": health.hint,
    }


def display_path(path: Path) -> str:
    """`/Users/me/.pebble` → `~/.pebble`; other paths unchanged."""
    home = Path.home().resolve()
    return f"~/{path.relative_to(home)}" if path.is_relative_to(home) else str(path)
