"""Turns per-chunk provider output into one validated transcript."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise
from typing import Any

from ..contract import CURRENT_SCHEMA_VERSION, Transcript, parse_transcript, require_valid
from ..db import now_iso
from ..errors import FailureCode, PipelineError
from ..providers.base import RawSegment, TranscriptionProvider
from .review import ReviewConfig, review_flags

#: How far a segment may end past its chunk's end (frame rounding). The same tolerance the
#: FunASR provider and the transcript contract use.
BOUND_TOLERANCE_MS = 500


@dataclass(frozen=True)
class ChunkResult:
    start_ms: int
    segments: Sequence[RawSegment]
    index: int | None = None
    #: The chunk's end in episode time. When known, every kept segment must lie inside the
    #: chunk (within BOUND_TOLERANCE_MS at the end). Benchmark overlap runs leave it unset.
    end_ms: int | None = None


@dataclass(frozen=True)
class MergeReport:
    """What merge did with the provider's segments. Counts and milliseconds only; never text."""

    kept: int
    dropped_empty_text: int
    dropped_zero_length: int
    dropped_past_duration: int
    clamped_to_duration: int
    overlaps: int
    max_overlap_ms: int

    def __str__(self) -> str:
        return (
            f"kept={self.kept} dropped_empty_text={self.dropped_empty_text} "
            f"dropped_zero_length={self.dropped_zero_length} "
            f"dropped_past_duration={self.dropped_past_duration} "
            f"clamped_to_duration={self.clamped_to_duration} overlaps={self.overlaps} "
            f"max_overlap_ms={self.max_overlap_ms}"
        )


def _structural_failure(message: str) -> PipelineError:
    # Only Pebble's own bookkeeping can produce these; the message never contains text.
    return PipelineError(FailureCode.INTERNAL_ERROR, message)


def merge(
    *,
    episode_id: str,
    duration_ms: int,
    language: str,
    chunks: Sequence[ChunkResult],
    provider: TranscriptionProvider,
    review: ReviewConfig | None = None,
) -> Transcript:
    """`merge_with_report` without the report."""
    transcript, _ = merge_with_report(
        episode_id=episode_id,
        duration_ms=duration_ms,
        language=language,
        chunks=chunks,
        provider=provider,
        review=review,
    )
    return transcript


def merge_with_report(
    *,
    episode_id: str,
    duration_ms: int,
    language: str,
    chunks: Sequence[ChunkResult],
    provider: TranscriptionProvider,
    review: ReviewConfig | None = None,
) -> tuple[Transcript, MergeReport]:
    """
    Offsets chunk-relative times, drops empty/zero-length output, renumbers, validates.
    ASR output also gets its chunk index, structural review flags (pipeline/review.py) and
    model/runtime provenance; mock output is unchanged.

    Chunk indices, when given, must be unique and, when every chunk has one, exactly 0…n-1.
    Each segment is checked in this order:

    1. a negative length (end before start) or a negative start fails the merge;
    2. empty or whitespace-only text is dropped (counted);
    3. exactly zero length is dropped (counted);
    4. a kept segment must start inside its chunk and end at most BOUND_TOLERANCE_MS past
       it (when the chunk's end is known), or the merge fails;
    5. its end is capped at the episode duration (counted); one that would then be empty is
       dropped (counted).

    Failures are INTERNAL_ERROR: valid provider output never triggers them. Passing these
    checks means the timings are consistent, not that every spoken word was transcribed.
    """
    review = review or ReviewConfig()
    _check_indices(chunks)
    dropped_empty = dropped_zero = dropped_past = clamped = 0
    absolute: list[tuple[int, int, RawSegment, int | None]] = []
    for chunk in chunks:
        chunk_length = None if chunk.end_ms is None else chunk.end_ms - chunk.start_ms
        for raw in chunk.segments:
            if raw.end_ms < raw.start_ms or raw.start_ms < 0:
                raise _structural_failure(
                    "A transcribed line had invalid timing; nothing was merged."
                )
            if not raw.text.strip():
                dropped_empty += 1
                continue
            if raw.end_ms == raw.start_ms:
                dropped_zero += 1
                continue
            if chunk_length is not None and (
                raw.start_ms >= chunk_length or raw.end_ms > chunk_length + BOUND_TOLERANCE_MS
            ):
                raise _structural_failure(
                    "A transcribed line fell outside its audio section; nothing was merged."
                )
            start = chunk.start_ms + raw.start_ms
            end = chunk.start_ms + raw.end_ms
            if end > duration_ms:
                clamped += 1
                end = duration_ms
            if end <= start:
                dropped_past += 1
                continue
            absolute.append((start, end, raw, chunk.index))
    absolute.sort(key=lambda item: (item[0], item[1]))

    overlaps = max_overlap = 0
    for (_, previous_end, _, _), (start, _, _, _) in pairwise(absolute):
        if start < previous_end:
            overlaps += 1
            max_overlap = max(max_overlap, previous_end - start)

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
    report = MergeReport(
        kept=len(segments),
        dropped_empty_text=dropped_empty,
        dropped_zero_length=dropped_zero,
        dropped_past_duration=dropped_past,
        clamped_to_duration=clamped,
        overlaps=overlaps,
        max_overlap_ms=max_overlap,
    )
    return require_valid(parse_transcript(payload)), report


def _check_indices(chunks: Sequence[ChunkResult]) -> None:
    indices = [chunk.index for chunk in chunks if chunk.index is not None]
    if len(set(indices)) != len(indices):
        raise _structural_failure("Two audio sections had the same number; nothing was merged.")
    if len(indices) == len(chunks) and sorted(indices) != list(range(len(chunks))):
        raise _structural_failure("An audio section was missing; nothing was merged.")
