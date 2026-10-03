"""Worker health: tools, data directory and providers. Never reports filesystem paths."""

from __future__ import annotations

import os

from . import __version__
from .config import Settings
from .contract import CURRENT_SCHEMA_VERSION, WorkerHealth
from .pipeline.tools import tool_version
from .providers.base import TranscriptionProvider
from .storage import Storage


def check_health(
    settings: Settings, storage: Storage, providers: list[TranscriptionProvider]
) -> WorkerHealth:
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
            "tools": {
                "ffmpeg": {"available": ffmpeg is not None, "version": ffmpeg},
                "ffprobe": {"available": ffprobe is not None, "version": ffprobe},
            },
            "providers": provider_status,
        }
    )


def _health(provider: TranscriptionProvider) -> dict[str, object]:
    health = provider.health()
    return {"available": health.available, "detail": health.detail}
