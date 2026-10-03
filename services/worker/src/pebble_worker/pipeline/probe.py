"""ffprobe: confirm the file has an audio stream and read its duration."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from ..errors import FailureCode, PipelineError
from .tools import CancelCheck, never_cancelled, run_tool


@dataclass(frozen=True)
class ProbeResult:
    duration_ms: int
    codec: str
    format_name: str
    sample_rate: int | None
    channels: int | None


def probe(
    path: Path, *, ffprobe: str, max_seconds: float, cancel: CancelCheck = never_cancelled
) -> ProbeResult:
    result = run_tool(
        [
            ffprobe,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        cancel,
    )
    if result.returncode != 0:
        raise PipelineError(
            FailureCode.UNSUPPORTED_MEDIA,
            "This file couldn't be read as audio.",
            hint="Use a common audio format such as M4A, MP3, WAV, FLAC or OGG.",
        )
    try:
        info = json.loads(result.stdout or "{}")
    except json.JSONDecodeError as error:
        raise PipelineError(
            FailureCode.UNSUPPORTED_MEDIA, "ffprobe output was unreadable."
        ) from error

    audio = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), None)
    if audio is None:
        raise PipelineError(
            FailureCode.NO_AUDIO_STREAM,
            "This file has no audio track.",
            hint="Choose an audio file, or a video file that contains sound.",
        )

    raw = audio.get("duration") or info.get("format", {}).get("duration")
    try:
        seconds = float(raw)
    except (TypeError, ValueError):
        seconds = 0.0
    if seconds <= 0:
        raise PipelineError(FailureCode.UNSUPPORTED_MEDIA, "The audio's duration couldn't be read.")
    if seconds > max_seconds:
        raise PipelineError(
            FailureCode.AUDIO_TOO_LONG,
            f"This audio is {seconds / 3600:.1f} h long; the limit is {max_seconds / 3600:.1f} h.",
            hint="Trim the file, or raise PEBBLE_MAX_AUDIO_SECONDS.",
        )

    def as_int(value: object) -> int | None:
        try:
            return int(value)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return None

    return ProbeResult(
        duration_ms=round(seconds * 1000),
        codec=str(audio.get("codec_name", "unknown")),
        format_name=str(info.get("format", {}).get("format_name", "unknown")),
        sample_rate=as_int(audio.get("sample_rate")),
        channels=as_int(audio.get("channels")),
    )
