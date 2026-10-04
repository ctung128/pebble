"""
Numbers computed from one benchmark run. Structural timing only: nothing here judges or
claims anything about the recognized text, which needs a human or a trustworthy reference.
"""

from __future__ import annotations

import random
import statistics
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise

from ..contract import Segment, Transcript
from ..pipeline.chunk import ChunkPlan
from ..pipeline.review import REVIEW_FLAGS

#: A segment that starts or ends this close to a chunk cut is "near" it.
NEAR_CUT_MS = 300
#: The review list per run is capped at this many segments.
REVIEW_CAP = 20
#: Randomly chosen unflagged segments (away from cuts) for comparison.
CONTROLS = 5
DURATION_BUCKETS = (
    ("<0.8s", 0, 800),
    ("0.8-2s", 800, 2000),
    ("2-5s", 2000, 5000),
    ("5-7s", 5000, 7001),
    (">7s", 7001, None),
)


def duration_summary(values: Sequence[int]) -> dict[str, float | int | None]:
    if not values:
        return {"count": 0, "min": None, "p25": None, "median": None, "p75": None, "max": None}
    ordered = sorted(values)
    quartiles = statistics.quantiles(ordered, n=4) if len(ordered) > 1 else [ordered[0]] * 3
    return {
        "count": len(ordered),
        "min": ordered[0],
        "p25": round(quartiles[0]),
        "median": round(statistics.median(ordered)),
        "p75": round(quartiles[2]),
        "max": ordered[-1],
    }


def segment_shape(transcript: Transcript) -> dict[str, object]:
    durations = [s.end_ms - s.start_ms for s in transcript.segments]
    total = len(durations)
    flags = {flag: 0 for flag in REVIEW_FLAGS}
    for segment in transcript.segments:
        for flag in segment.review.flags if segment.review else []:
            flags[flag] += 1
    return {
        "count": total,
        "durationMs": duration_summary(durations),
        "buckets": {
            name: sum(1 for d in durations if d >= low and (high is None or d < high))
            for name, low, high in DURATION_BUCKETS
        },
        "flags": {
            flag: {"count": count, "share": round(count / total, 4) if total else 0.0}
            for flag, count in flags.items()
        },
        "unflagged": sum(1 for s in transcript.segments if not (s.review and s.review.flags)),
    }


def chunk_shape(plans: Sequence[ChunkPlan]) -> dict[str, object]:
    cuts = [p.cut for p in plans if p.cut != "end"]
    return {
        "count": len(plans),
        "silenceCuts": cuts.count("silence"),
        "forcedCuts": cuts.count("hard"),
        "durationMs": duration_summary([p.end_ms - p.start_ms for p in plans]),
    }


def merge_checks(transcript: Transcript) -> dict[str, object]:
    segments = transcript.segments
    overlaps = [
        prev.end_ms - seg.start_ms for prev, seg in pairwise(segments) if seg.start_ms < prev.end_ms
    ]
    return {
        "schemaValid": True,  # merge() validates every transcript before returning it
        "ordered": all(a.start_ms <= b.start_ms for a, b in pairwise(segments)),
        "overlaps": len(overlaps),
        "maxOverlapMs": max(overlaps, default=0),
        "withinDuration": all(s.end_ms <= transcript.duration_ms for s in segments),
    }


def boundary_analysis(
    plans: Sequence[ChunkPlan], transcript: Transcript
) -> list[dict[str, object]]:
    """Per cut: its kind, segments near it, and the timing gap across it. No text judgments."""
    rows = []
    segments = transcript.segments
    for plan in plans:
        if plan.cut == "end":
            continue
        cut = plan.end_ms
        before = [s for s in segments if s.start_ms < cut]
        after = [s for s in segments if s.start_ms >= cut]
        last_before = before[-1] if before else None
        first_after = after[0] if after else None
        rows.append(
            {
                "cutMs": cut,
                "kind": "forced" if plan.cut == "hard" else "silence",
                "segmentsStartingNear": sum(
                    1 for s in segments if abs(s.start_ms - cut) <= NEAR_CUT_MS
                ),
                "segmentsEndingNear": sum(
                    1 for s in segments if abs(s.end_ms - cut) <= NEAR_CUT_MS
                ),
                "gapAcrossCutMs": (
                    first_after.start_ms - last_before.end_ms
                    if last_before is not None and first_after is not None
                    else None
                ),
                "segmentCrossesCut": last_before is not None and last_before.end_ms > cut,
            }
        )
    return rows


def boundary_summary(rows: Sequence[dict[str, object]]) -> dict[str, object]:
    def of(kind: str) -> dict[str, object]:
        picked = [r for r in rows if r["kind"] == kind]
        gaps = [int(r["gapAcrossCutMs"]) for r in picked if r["gapAcrossCutMs"] is not None]  # type: ignore[call-overload]
        return {
            "cuts": len(picked),
            "cutsWithSegmentStartNear": sum(1 for r in picked if r["segmentsStartingNear"]),
            "cutsWithSegmentEndNear": sum(1 for r in picked if r["segmentsEndingNear"]),
            "cutsWithNegativeGap": sum(1 for g in gaps if g < 0),
            "gapAcrossCutMs": duration_summary(gaps),
        }

    return {"forced": of("forced"), "silence": of("silence")}


# --- character error rate -----------------------------------------------------------------------


def normalize_for_cer(text: str) -> str:
    """NFKC, lowercase, and only letters/digits/CJK: punctuation and spacing don't count."""
    folded = unicodedata.normalize("NFKC", text).lower()
    return "".join(ch for ch in folded if unicodedata.category(ch)[0] in ("L", "N"))


def character_error_rate(hypothesis: str, reference: str) -> float | None:
    hyp, ref = normalize_for_cer(hypothesis), normalize_for_cer(reference)
    if not ref:
        return None
    previous = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, start=1):
        current = [i] + [0] * len(hyp)
        for j, h in enumerate(hyp, start=1):
            current[j] = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (r != h))
        previous = current
    return round(previous[-1] / len(ref), 4)


# --- review selection ---------------------------------------------------------------------------

REASON_ORDER = (
    "forced-cut-adjacent",
    "timestamp-alignment-anomaly",
    "long-or-short",
    "silence-cut-adjacent",
    "speech-gap",
    "control",
)


@dataclass(frozen=True)
class ReviewPick:
    segment: Segment
    reasons: tuple[str, ...]


def select_for_review(
    plans: Sequence[ChunkPlan], transcript: Transcript, *, seed: int
) -> list[ReviewPick]:
    """
    Every segment next to a chunk cut, every flagged segment, and up to five random unflagged
    controls — capped at REVIEW_CAP, keeping the highest-priority reasons (REASON_ORDER).
    """
    segments = transcript.segments
    reasons: dict[str, set[str]] = {s.id: set() for s in segments}
    for plan in plans:
        if plan.cut == "end":
            continue
        kind = "forced-cut-adjacent" if plan.cut == "hard" else "silence-cut-adjacent"
        before = [s for s in segments if s.start_ms < plan.end_ms]
        after = [s for s in segments if s.start_ms >= plan.end_ms]
        for neighbour in (before[-1] if before else None, after[0] if after else None):
            if neighbour is not None:
                reasons[neighbour.id].add(kind)
    for segment in segments:
        flags = set(segment.review.flags) if segment.review else set()
        if "timestamp_alignment_anomaly" in flags:
            reasons[segment.id].add("timestamp-alignment-anomaly")
        if flags & {"long_segment", "short_fragment"}:
            reasons[segment.id].add("long-or-short")
        if "speech_gap" in flags:
            reasons[segment.id].add("speech-gap")
    unremarkable = [s for s in segments if not reasons[s.id]]
    for segment in random.Random(seed).sample(unremarkable, min(CONTROLS, len(unremarkable))):
        reasons[segment.id].add("control")

    def priority(segment: Segment) -> tuple[int, int]:
        best = min(REASON_ORDER.index(r) for r in reasons[segment.id])
        return (best, segment.start_ms)

    picked = sorted((s for s in segments if reasons[s.id]), key=priority)[:REVIEW_CAP]
    picked.sort(key=lambda s: s.start_ms)
    return [ReviewPick(s, tuple(r for r in REASON_ORDER if r in reasons[s.id])) for s in picked]
