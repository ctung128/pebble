"""Turns per-chunk provider output into one validated transcript."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from ..contract import CURRENT_SCHEMA_VERSION, Transcript, parse_transcript, require_valid
from ..db import now_iso
from ..providers.base import RawSegment, TranscriptionProvider
from .review import ReviewConfig, review_flags


@dataclass(frozen=True)
class ChunkResult:
    start_ms: int
    segments: Sequence[RawSegment]
    index: int | None = None


def merge(
    *,
    episode_id: str,
    duration_ms: int,
    language: str,
    chunks: Sequence[ChunkResult],
    provider: TranscriptionProvider,
    review: ReviewConfig | None = None,
) -> Transcript:
    """
    Offsets chunk-relative times, drops empty/zero-length output, renumbers, validates.
    ASR output also gets its chunk index, structural review flags (pipeline/review.py) and
    model/runtime provenance; mock output is unchanged.
    """
    review = review or ReviewConfig()
    absolute: list[tuple[int, int, RawSegment, int | None]] = []
    for chunk in chunks:
        for raw in chunk.segments:
            start = chunk.start_ms + raw.start_ms
            end = min(chunk.start_ms + raw.end_ms, duration_ms)
            if end > start and raw.text.strip():
                absolute.append((start, end, raw, chunk.index))
    absolute.sort(key=lambda item: (item[0], item[1]))
    is_asr = provider.kind == "asr"
    flags = (
        review_flags([(start, end, raw.review_flags) for start, end, raw, _ in absolute], review)
        if is_asr
        else [[] for _ in absolute]
    )
    segments: list[dict[str, Any]] = []
    for i, (start, end, raw, chunk_index) in enumerate(absolute):
        segment: dict[str, Any] = {
            "id": f"seg-{i + 1:04d}",
            "index": i,
            "startMs": start,
            "endMs": end,
            "text": raw.text.strip(),
            "speaker": raw.speaker,
            "confidence": raw.confidence,
            "tokens": None,
        }
        if is_asr:
            if chunk_index is not None:
                segment["chunkIndex"] = chunk_index
            segment["review"] = {"flags": flags[i]}
        segments.append(segment)

    provenance: dict[str, Any] = {
        "kind": provider.kind,
        "provider": provider.id,
        "model": provider.model,
        "createdAt": now_iso(),
        "notes": provider.provenance_note,
    }
    details = provider.provenance_details() if is_asr else None
    if details is not None:
        provenance["models"] = [
            {"role": m.role, "id": m.id, "revision": m.revision} for m in details.models
        ]
        provenance["runtime"] = dict(details.runtime)
        provenance["review"] = {"thresholds": review.as_contract()}

    payload = {
        "schemaVersion": CURRENT_SCHEMA_VERSION,
        "episodeId": episode_id,
        "language": language,
        "script": provider.script,
        "durationMs": duration_ms,
        "segments": segments,
        "provenance": provenance,
    }
    return require_valid(parse_transcript(payload))
