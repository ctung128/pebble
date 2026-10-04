"""
Benchmark-only chunk overlap (M1-B2). Never used by the worker's job pipeline.

Chunk *planning* is unchanged: each chunk owns `[start, end)` of the original audio, cut at the
same silence as today. With an overlap O (ms), each chunk's *audio* extends O/2 past each of its
inner cuts, so neighbours share O ms centred on the cut. Provider times are relative to the
chunk's audio start, so `audio_start + t` stays in original-audio time.

The resolver keeps every candidate unless it materially overlaps (in time) an already kept
candidate from another chunk; then the one farther from its own chunk's audio edge wins and the
other is excluded with exactly one reason. Text is never joined, edited or invented, and text
comparisons only label diagnostics. If kept segments would still overlap, the run fails.
"""

from __future__ import annotations

import wave
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

from ..pipeline.chunk import ChunkPlan
from ..pipeline.merge import ChunkResult
from ..providers.base import RawSegment
from ..providers.funasr import OVERLAP_TOLERANCE_MS
from ..storage import make_private
from .analysis import normalize_for_cer

MAX_OVERLAP_MS = 2000
#: A time overlap of at least this share of the shorter candidate is "material".
MATERIAL_SHARE = 0.5
#: Decisions between candidates whose edge distances differ by less than this are ambiguous.
AMBIGUOUS_EDGE_MS = 250
#: Shared normalized characters that suggest text repeated across a cut (diagnostic only).
REPEAT_CHARS = 6
#: Kept candidates this close to a cut are compared for possible repeats.
REPEAT_WINDOW_MS = 4000
EXCLUSION_REASONS = ("duplicateRemoved", "conflictLoser")


class OverlapUnresolved(Exception):
    """Kept segments still overlap; the experiment run fails rather than trimming anything."""

    def __init__(self, count: int, diagnostics: dict[str, object]) -> None:
        super().__init__(f"{count} overlapping segment pair(s) remain after resolution")
        self.count = count
        self.diagnostics = diagnostics


@dataclass(frozen=True)
class ChunkRange:
    index: int
    owned_start: int
    owned_end: int
    audio_start: int
    audio_end: int


def chunk_ranges(plans: Sequence[ChunkPlan], duration_ms: int, overlap_ms: int) -> list[ChunkRange]:
    if not 0 <= overlap_ms <= MAX_OVERLAP_MS:
        raise ValueError(f"Overlap must be between 0 and {MAX_OVERLAP_MS} ms.")
    half = overlap_ms // 2
    ranges = []
    for n, plan in enumerate(plans):
        last = n == len(plans) - 1
        owned_end = duration_ms if last else plan.end_ms
        ranges.append(
            ChunkRange(
                index=plan.index,
                owned_start=plan.start_ms,
                owned_end=owned_end,
                audio_start=0 if n == 0 else max(0, plan.start_ms - half),
                audio_end=duration_ms if last else min(duration_ms, plan.end_ms + half),
            )
        )
    return ranges


def write_context_chunks(
    wav_path: Path, ranges: Sequence[ChunkRange], chunks_dir: Path
) -> list[Path]:
    """Sample-exact slices of the normalized WAV covering each chunk's audio range."""
    paths: list[Path] = []
    with wave.open(str(wav_path), "rb") as source:
        rate, total, params = source.getframerate(), source.getnframes(), source.getparams()
        for n, chunk in enumerate(ranges):
            first = round(chunk.audio_start * rate / 1000)
            end = round(chunk.audio_end * rate / 1000)
            last = total if n == len(ranges) - 1 else min(total, end)
            source.setpos(first)
            frames = source.readframes(last - first)
            path = chunks_dir / f"chunk-{chunk.index:04d}.wav"
            with wave.open(str(path), "wb") as out:
                out.setparams(params)
                out.writeframes(frames)
            make_private(path)
            paths.append(path)
    return paths


@dataclass
class _Candidate:
    chunk: int  # position in `ranges`
    raw: RawSegment
    start: int
    end: int
    edge: int  # distance from the midpoint to the nearest edge of its chunk's audio
    owned: bool
    norm: str

    @property
    def mid(self) -> float:
        return (self.start + self.end) / 2


@dataclass
class Resolution:
    chunks: list[ChunkResult]
    diagnostics: dict[str, object]
    #: Private review items (kinds and original-audio times only; never text).
    review_items: list[dict[str, object]] = field(default_factory=list)


def _overlap(a: _Candidate, b: _Candidate) -> int:
    return max(0, min(a.end, b.end) - max(a.start, b.start))


def _material(a: _Candidate, b: _Candidate) -> bool:
    shorter = min(a.end - a.start, b.end - b.start)
    return shorter > 0 and _overlap(a, b) >= MATERIAL_SHARE * shorter


def _shares_run(a: str, b: str, length: int) -> bool:
    """True when `a` and `b` share a run of at least `length` characters."""
    if min(len(a), len(b)) < length:
        return False
    runs = {a[i : i + length] for i in range(len(a) - length + 1)}
    return any(b[i : i + length] in runs for i in range(len(b) - length + 1))


def resolve(
    ranges: Sequence[ChunkRange], outputs: Sequence[Sequence[RawSegment]], duration_ms: int
) -> Resolution:
    """Chunk outputs (times relative to each chunk's audio start) → de-duplicated chunk results."""
    candidates: list[_Candidate] = []
    for position, (chunk, segments) in enumerate(zip(ranges, outputs, strict=True)):
        last = position == len(ranges) - 1
        for raw in segments:
            start = chunk.audio_start + raw.start_ms
            end = min(chunk.audio_start + raw.end_ms, duration_ms)
            if end <= start or not raw.text.strip():
                continue  # the merge step drops these too
            mid = (start + end) / 2
            owned = chunk.owned_start <= mid < chunk.owned_end or (last and mid == chunk.owned_end)
            candidates.append(
                _Candidate(
                    chunk=position,
                    raw=raw,
                    start=start,
                    end=end,
                    edge=round(min(mid - chunk.audio_start, chunk.audio_end - mid)),
                    owned=owned,
                    norm=normalize_for_cer(raw.text),
                )
            )
    cuts = [r.owned_end for r in ranges[:-1]]

    def nearest_cut(c: _Candidate) -> int | None:
        if not cuts:
            return None
        return min(range(len(cuts)), key=lambda i: abs(cuts[i] - c.mid))

    per_cut = [
        {
            "cut": i + 1,
            "duplicateRemoved": 0,
            "conflictLoser": 0,
            "ambiguous": 0,
            "foreignOrphanKept": 0,
            "possibleRepeatAcrossCut": 0,
            "chosenLeft": 0,
            "chosenRight": 0,
            "conflictTextLengths": [],
        }
        for i in range(len(cuts))
    ]
    review_items: list[dict[str, object]] = []
    kept: list[_Candidate] = []
    excluded: dict[str, int] = dict.fromkeys(EXCLUSION_REASONS, 0)
    ambiguous = 0

    order = sorted(candidates, key=lambda c: (-c.edge, not c.owned, c.chunk, c.start, c.end))
    for candidate in order:
        rivals = [k for k in kept if k.chunk != candidate.chunk and _material(candidate, k)]
        if not rivals:
            kept.append(candidate)
            continue
        rival = max(rivals, key=lambda k: _overlap(candidate, k))
        reason = "duplicateRemoved" if candidate.norm == rival.norm else "conflictLoser"
        excluded[reason] += 1
        at = nearest_cut(candidate)
        is_ambiguous = len(rivals) > 1 or abs(rival.edge - candidate.edge) < AMBIGUOUS_EDGE_MS
        ambiguous += is_ambiguous
        if at is not None:
            row = per_cut[at]
            row[reason] += 1  # type: ignore[operator]
            row["ambiguous"] += is_ambiguous  # type: ignore[operator]
            row["chosenLeft" if rival.chunk <= at else "chosenRight"] += 1  # type: ignore[operator]
            if reason == "conflictLoser":
                row["conflictTextLengths"].append(  # type: ignore[attr-defined]
                    {"kept": len(rival.norm), "excluded": len(candidate.norm)}
                )
        if reason == "conflictLoser" or is_ambiguous:
            review_items.append(
                {
                    "kind": "conflict" if reason == "conflictLoser" else "ambiguous",
                    "cut": None if at is None else at + 1,
                    "startMs": min(candidate.start, rival.start),
                    "endMs": max(candidate.end, rival.end),
                }
            )

    kept.sort(key=lambda c: (c.start, c.end))
    foreign = [c for c in kept if not c.owned]
    for c in foreign:
        at = nearest_cut(c)
        if at is not None:
            per_cut[at]["foreignOrphanKept"] += 1  # type: ignore[operator]

    repeats = 0
    for i, cut in enumerate(cuts):
        left = [c for c in kept if c.chunk == i and abs(c.mid - cut) <= REPEAT_WINDOW_MS]
        right = [c for c in kept if c.chunk == i + 1 and abs(c.mid - cut) <= REPEAT_WINDOW_MS]
        for a in left:
            for b in right:
                if not _material(a, b) and _shares_run(a.norm, b.norm, REPEAT_CHARS):
                    repeats += 1
                    per_cut[i]["possibleRepeatAcrossCut"] += 1  # type: ignore[operator]
                    review_items.append(
                        {
                            "kind": "possibleRepeatAcrossCut",
                            "cut": i + 1,
                            "startMs": min(a.start, b.start),
                            "endMs": max(a.end, b.end),
                        }
                    )

    unresolved, latest_end = 0, None
    for c in kept:
        if latest_end is not None and c.start < latest_end - OVERLAP_TOLERANCE_MS:
            unresolved += 1
        latest_end = c.end if latest_end is None else max(latest_end, c.end)

    diagnostics: dict[str, object] = {
        "candidates": len(candidates),
        "kept": len(kept),
        "excluded": excluded,
        "ambiguous": ambiguous,
        "foreignOrphanKept": len(foreign),
        "possibleRepeatAcrossCut": repeats,
        "unresolvedOverlaps": unresolved,
        "reconciled": len(candidates) == len(kept) + sum(excluded.values()),
        "perCut": per_cut,
        "extraAudioMs": sum(r.audio_end - r.audio_start for r in ranges)
        - sum(r.owned_end - r.owned_start for r in ranges),
    }
    if unresolved:
        raise OverlapUnresolved(unresolved, diagnostics)

    by_chunk: list[list[RawSegment]] = [[] for _ in ranges]
    for c in kept:
        by_chunk[c.chunk].append(c.raw)
    chunks = [ChunkResult(r.audio_start, by_chunk[n], index=r.index) for n, r in enumerate(ranges)]
    return Resolution(chunks, diagnostics, review_items)
