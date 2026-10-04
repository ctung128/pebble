"""
Numbers computed from one benchmark run. Structural timing only: nothing here judges or
claims anything about the recognized text, which needs a human or a trustworthy reference.
"""

from __future__ import annotations

import random
import statistics
import unicodedata
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise
from typing import TYPE_CHECKING, Literal

from ..contract import Segment, Transcript
from ..pipeline.chunk import ChunkPlan
from ..pipeline.review import REVIEW_FLAGS

if TYPE_CHECKING:
    from ..providers.funasr import ChunkAlignment

#: A segment that starts or ends this close to a chunk cut is "near" it.
NEAR_CUT_MS = 300
#: The review list per run is capped at this many segments.
REVIEW_CAP = 20
#: Randomly chosen unflagged segments (away from cuts) for comparison, reserved first.
CONTROLS = 5
#: Slots per category before redistribution, and the most any one category may take.
QUOTAS = {"cut-neighbour": 6, "long-segment": 3, "short-fragment": 3, "speech-gap": 3}
CATEGORY_CAP = 8
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


# --- alignment diagnostic -----------------------------------------------------------------------

ALIGNMENT_REASONS = (
    "count_difference",
    "timestamp_outside_segment_range",
    "timestamps_out_of_order",
    "malformed_timestamps",
)
COUNT_DIFFERENCE_BUCKETS = ("<=-3", "-2", "-1", "+1", "+2", ">=+3")


def _difference_bucket(value: int) -> str:
    if value <= -3:
        return "<=-3"
    if value >= 3:
        return ">=+3"
    return f"{value:+d}"


def alignment_summary(chunks: Sequence[ChunkAlignment | None]) -> dict[str, object]:
    """
    The private `timestamp_alignment_anomaly` diagnostic, as numbers: sentences by reason, the
    signed timestamps-minus-tokens histogram, and each chunk's text/timestamp totals.
    """
    issues = [issue for chunk in chunks if chunk for issue in chunk.issues]
    flagged = [issue for issue in issues if issue is not None]
    differences = Counter(
        _difference_bucket(issue.count_difference)
        for issue in flagged
        if issue.count_difference is not None
    )
    rows = [
        {
            "index": index,
            "textTokens": chunk.text_tokens,
            "timestamps": chunk.timestamps,
            "consistent": chunk.timestamps == chunk.text_tokens,
        }
        for index, chunk in enumerate(chunks)
        if chunk is not None
    ]
    return {
        "sentences": len(issues),
        "flagged": len(flagged),
        "byReason": {r: sum(i.reason == r for i in flagged) for r in ALIGNMENT_REASONS},
        "countDifference": {bucket: differences[bucket] for bucket in COUNT_DIFFERENCE_BUCKETS},
        "chunks": {
            "checked": len(rows),
            "consistent": sum(bool(r["consistent"]) for r in rows),
            "totals": rows,
        },
    }


# --- review selection ---------------------------------------------------------------------------

CutKind = Literal["forced", "silence"]
#: Redistribution order for slots a category can't fill.
CATEGORIES = ("cut-neighbour", "long-segment", "short-fragment", "speech-gap", "control")


def cuts_from_plans(plans: Sequence[ChunkPlan]) -> list[tuple[int, CutKind]]:
    return [(p.end_ms, "forced" if p.cut == "hard" else "silence") for p in plans if p.cut != "end"]


@dataclass(frozen=True)
class ReviewPick:
    segment: Segment
    category: str
    reasons: tuple[str, ...]


def select_for_review(
    cuts: Sequence[tuple[int, CutKind]], transcript: Transcript, *, seed: int
) -> list[ReviewPick]:
    """
    Up to REVIEW_CAP segments with reserved comparison coverage, in chronological order:

    1. CONTROLS random segments with no review flags and not next to a cut, reserved first;
    2. QUOTAS per category: cut neighbours (the last segment before and first after each cut;
       forced cuts outrank silence cuts), long segments, short fragments, speech gaps;
    3. unfilled slots go round-robin through CATEGORIES, at most CATEGORY_CAP per category.

    `timestamp_alignment_anomaly` is a private diagnostic and earns no slot. Each segment
    appears once, under the first category that picks it. Each category's order comes from
    its own seed (run seed + category), so one category's candidates don't reshuffle another.
    """
    segments = transcript.segments
    by_id = {s.id: s for s in segments}
    flags = {s.id: set(s.review.flags) if s.review else set() for s in segments}
    neighbours: dict[CutKind, set[str]] = {"forced": set(), "silence": set()}
    for cut_ms, kind in cuts:
        before = [s for s in segments if s.start_ms < cut_ms]
        after = [s for s in segments if s.start_ms >= cut_ms]
        for segment in (before[-1] if before else None, after[0] if after else None):
            if segment is not None:
                neighbours[kind].add(segment.id)
    neighbours["silence"] -= neighbours["forced"]
    adjacent = neighbours["forced"] | neighbours["silence"]

    def ordered(name: str, ids: set[str]) -> list[str]:
        candidates = sorted(ids, key=lambda i: by_id[i].start_ms)
        random.Random(f"{seed}:{name}").shuffle(candidates)
        return candidates

    def flagged(flag: str) -> set[str]:
        return {i for i, f in flags.items() if flag in f}

    queues = {
        "cut-neighbour": ordered("forced-cut-neighbour", neighbours["forced"])
        + ordered("silence-cut-neighbour", neighbours["silence"]),
        "long-segment": ordered("long-segment", flagged("long_segment")),
        "short-fragment": ordered("short-fragment", flagged("short_fragment")),
        "speech-gap": ordered("speech-gap", flagged("speech_gap")),
        "control": ordered("control", {i for i in by_id if not flags[i] and i not in adjacent}),
    }
    picked: dict[str, str] = {}
    counts: Counter[str] = Counter()

    def take(category: str, limit: int) -> None:
        queue = queues[category]
        while queue and counts[category] < limit and len(picked) < REVIEW_CAP:
            candidate = queue.pop(0)
            if candidate not in picked:
                picked[candidate] = category
                counts[category] += 1

    take("control", CONTROLS)
    for category, quota in QUOTAS.items():
        take(category, quota)
    while len(picked) < REVIEW_CAP:
        before = len(picked)
        for category in CATEGORIES:
            take(category, min(CATEGORY_CAP, counts[category] + 1))
        if len(picked) == before:
            break

    def reasons(segment_id: str) -> tuple[str, ...]:
        found = []
        if segment_id in neighbours["forced"]:
            found.append("forced-cut-neighbour")
        if segment_id in neighbours["silence"]:
            found.append("silence-cut-neighbour")
        for flag, name in (
            ("long_segment", "long-segment"),
            ("short_fragment", "short-fragment"),
            ("speech_gap", "speech-gap"),
        ):
            if flag in flags[segment_id]:
                found.append(name)
        return tuple(found) or ("control",)

    chosen = sorted(picked, key=lambda i: by_id[i].start_ms)
    return [ReviewPick(by_id[i], picked[i], reasons(i)) for i in chosen]


def category_counts(picks: Sequence[ReviewPick]) -> dict[str, int]:
    counts = Counter(p.category for p in picks)
    return {category: counts[category] for category in CATEGORIES}
