"""Silence-aware chunking of the normalized WAV."""

from __future__ import annotations

import re
import wave
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from ..config import ChunkingConfig
from ..errors import Cancelled, FailureCode, PipelineError
from ..storage import make_private
from .tools import CancelCheck, never_cancelled, run_tool

CutKind = Literal["silence", "hard", "end"]

_START = re.compile(r"silence_start:\s*(-?[\d.]+)")
_END = re.compile(r"silence_end:\s*(-?[\d.]+)")


@dataclass(frozen=True)
class Silence:
    start_ms: int
    end_ms: int

    @property
    def mid_ms(self) -> int:
        return (self.start_ms + self.end_ms) // 2


@dataclass(frozen=True)
class ChunkPlan:
    index: int
    start_ms: int
    end_ms: int
    cut: CutKind


def detect_silences(
    wav_path: Path,
    duration_ms: int,
    config: ChunkingConfig,
    *,
    ffmpeg: str,
    cancel: CancelCheck = never_cancelled,
) -> list[Silence]:
    result = run_tool(
        [
            ffmpeg,
            "-nostdin",
            "-hide_banner",
            "-nostats",
            "-i",
            str(wav_path),
            "-af",
            f"silencedetect=noise={config.silence_noise_db}dB:d={config.silence_min_seconds}",
            "-f",
            "null",
            "-",
        ],
        cancel,
    )
    if result.returncode != 0:
        raise PipelineError(FailureCode.INTERNAL_ERROR, "Silence detection failed.")
    return parse_silences(result.stderr, duration_ms)


def parse_silences(log: str, duration_ms: int) -> list[Silence]:
    silences: list[Silence] = []
    start: int | None = None
    for line in log.splitlines():
        if match := _START.search(line):
            start = max(0, round(float(match.group(1)) * 1000))
        elif (match := _END.search(line)) and start is not None:
            silences.append(Silence(start, min(duration_ms, round(float(match.group(1)) * 1000))))
            start = None
    if start is not None:  # trailing silence runs to the end of the file
        silences.append(Silence(start, duration_ms))
    return silences


def plan_chunks(
    duration_ms: int, silences: list[Silence], config: ChunkingConfig
) -> list[ChunkPlan]:
    """
    Walks the audio: while more than `max` remains, cut at the silence midpoint closest to
    `target` that lies within [min, max] of the chunk start, or hard-cut at `target` if there
    is none. The remainder (at most `max`) becomes the last chunk.
    """
    target, low, high = (
        round(s * 1000) for s in (config.target_seconds, config.min_seconds, config.max_seconds)
    )
    plans: list[ChunkPlan] = []
    start = 0
    while duration_ms - start > high:
        window = [s.mid_ms for s in silences if start + low <= s.mid_ms <= start + high]
        if window:
            cut = min(window, key=lambda mid: (abs(mid - (start + target)), mid))
            kind: CutKind = "silence"
        else:
            cut, kind = start + target, "hard"
        plans.append(ChunkPlan(len(plans), start, cut, kind))
        start = cut
    plans.append(ChunkPlan(len(plans), start, duration_ms, "end"))
    return plans


def check_chunk_spans(spans: Sequence[tuple[int, int, int]], duration_ms: int) -> None:
    """
    `(index, start_ms, end_ms)` per chunk, in index order, must number 0…n-1 and tile the
    audio exactly: the first starts at 0, each starts where the previous ended, each has a
    positive length, and the last ends at `duration_ms`. Anything else is a bug in Pebble's
    own bookkeeping (INTERNAL_ERROR), so nothing is transcribed or merged from it.

    This proves the sections cover the audio, not that the provider transcribed every word.
    """
    expected_start = 0
    for position, (index, start, end) in enumerate(spans):
        if index != position or start != expected_start or end <= start:
            raise PipelineError(
                FailureCode.INTERNAL_ERROR, "Pebble's audio sections didn't line up."
            )
        expected_start = end
    if not spans or expected_start != duration_ms:
        raise PipelineError(
            FailureCode.INTERNAL_ERROR, "Pebble's audio sections didn't cover the whole audio."
        )


def write_chunks(
    wav_path: Path,
    plans: list[ChunkPlan],
    chunks_dir: Path,
    cancel: CancelCheck = never_cancelled,
) -> list[Path]:
    """Sample-exact slices of the normalized WAV (no re-encoding, no gaps, no overlap)."""
    paths: list[Path] = []
    with wave.open(str(wav_path), "rb") as source:
        rate = source.getframerate()
        total = source.getnframes()
        params = source.getparams()
        for plan in plans:
            if cancel():
                raise Cancelled()
            first = round(plan.start_ms * rate / 1000)
            last = total if plan.cut == "end" else round(plan.end_ms * rate / 1000)
            source.setpos(first)
            frames = source.readframes(last - first)
            path = chunks_dir / f"chunk-{plan.index:04d}.wav"
            with wave.open(str(path), "wb") as out:
                out.setparams(params)
                out.writeframes(frames)
            make_private(path)
            paths.append(path)
    return paths
