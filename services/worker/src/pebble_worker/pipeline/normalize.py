"""Decode to 16 kHz mono 16-bit PCM WAV — the input every provider receives."""

from __future__ import annotations

import wave
from pathlib import Path

from ..errors import FailureCode, PipelineError
from ..storage import make_private
from .tools import CancelCheck, never_cancelled, run_tool

SAMPLE_RATE = 16_000


def normalize(
    source: Path, target: Path, *, ffmpeg: str, cancel: CancelCheck = never_cancelled
) -> int:
    """Writes `target` and returns its exact duration in milliseconds."""
    result = run_tool(
        [
            ffmpeg,
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-i",
            str(source),
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
            str(target),
        ],
        cancel,
    )
    if result.returncode != 0 or not target.exists():
        if "No space left" in result.stderr:
            raise PipelineError(
                FailureCode.STORAGE_ERROR, "The disk is full.", hint="Free up space, then retry."
            )
        raise PipelineError(
            FailureCode.UNSUPPORTED_MEDIA,
            "The audio couldn't be decoded.",
            hint="The file may be damaged or use an unusual codec.",
        )
    make_private(target)
    return wav_duration_ms(target)


def wav_duration_ms(path: Path) -> int:
    with wave.open(str(path), "rb") as wav:
        return round(wav.getnframes() * 1000 / wav.getframerate())
