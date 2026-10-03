"""Turns per-chunk provider output into one validated transcript."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from ..contract import CURRENT_SCHEMA_VERSION, Transcript, parse_transcript, require_valid
from ..db import now_iso
from ..providers.base import RawSegment, TranscriptionProvider


@dataclass(frozen=True)
class ChunkResult:
    start_ms: int
    segments: Sequence[RawSegment]


def merge(
    *,
    episode_id: str,
    duration_ms: int,
    language: str,
    chunks: Sequence[ChunkResult],
    provider: TranscriptionProvider,
) -> Transcript:
    """Offsets chunk-relative times, drops empty/zero-length output, renumbers, validates."""
    absolute: list[tuple[int, int, RawSegment]] = []
    for chunk in chunks:
        for raw in chunk.segments:
            start = chunk.start_ms + raw.start_ms
            end = min(chunk.start_ms + raw.end_ms, duration_ms)
            if end > start and raw.text.strip():
                absolute.append((start, end, raw))
    absolute.sort(key=lambda item: (item[0], item[1]))

    payload = {
        "schemaVersion": CURRENT_SCHEMA_VERSION,
        "episodeId": episode_id,
        "language": language,
        "script": provider.script,
        "durationMs": duration_ms,
        "segments": [
            {
                "id": f"seg-{i + 1:04d}",
                "index": i,
                "startMs": start,
                "endMs": end,
                "text": raw.text.strip(),
                "speaker": raw.speaker,
                "confidence": raw.confidence,
                "tokens": None,
            }
            for i, (start, end, raw) in enumerate(absolute)
        ],
        "provenance": {
            "kind": provider.kind,
            "provider": provider.id,
            "model": provider.model,
            "createdAt": now_iso(),
            "notes": provider.provenance_note,
        },
    }
    return require_valid(parse_transcript(payload))
