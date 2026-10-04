"""
`bench compare`: baseline (no overlap) against overlap variants of the same clip and chunk
plan, plus optional reference runs (other chunk targets) whose cuts are elsewhere. It reads
saved results and transcripts only and reports numbers and neutral labels — never text.

The automated classification covers only the numeric criteria in docs/BENCHMARKS.md; the
human-review criteria come from the blinded paired review (`bench pair`, `bench tally`).
"""

from __future__ import annotations

import hashlib
import json
import statistics
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..contract import Transcript, parse_transcript
from ..storage import PRIVATE_DIR, Storage, make_private
from .analysis import WINDOW_HALF_MS, normalize_for_cer, window_metrics
from .paths import bench_root, run_file
from .results import RunResult

#: Segments farther than this from every cut are compared for stability.
STABILITY_DISTANCE_MS = 10_000
#: Start/end tolerance when matching a segment away from cuts.
STABILITY_TOLERANCE_MS = 150
STABILITY_REQUIRED = 0.95
PROMISING_GAIN = 0.20
REJECT_LOSS = -0.10
GAP_CLOSURE_STRONG = 0.5
#: An overlap beyond this between neighbouring segments is invalid (the provider's tolerance).
OVERLAP_TOLERANCE_MS = 100


class CompareError(ValueError):
    pass


def load(storage: Storage, run_id: str) -> tuple[RunResult, Transcript | None]:
    result_path = run_file(storage, run_id, "result.json")
    if not result_path.is_file():
        raise CompareError(f"{run_id}: no saved result.")
    result = RunResult.model_validate(json.loads(result_path.read_text(encoding="utf-8")))
    transcript_path = run_file(storage, run_id, "transcript.json")
    if not transcript_path.is_file():
        return result, None
    parsed = parse_transcript(json.loads(transcript_path.read_text(encoding="utf-8")))
    if not parsed.ok or parsed.data is None:
        raise CompareError(f"{run_id}: transcript.json is not a valid transcript.")
    return result, parsed.data


def label(result: RunResult) -> str:
    return f"{result.chunking.target_seconds:g} s · overlap {result.chunking.overlap_ms} ms"


def cuts_of(result: RunResult) -> list[int]:
    return [int(row["cutMs"]) for row in (result.boundaries or {}).get("cuts", [])]


def valid(result: RunResult) -> bool:
    merge = result.merge or {}
    return (
        result.status == "completed"
        and bool(merge.get("ordered"))
        and bool(merge.get("withinDuration"))
        and int(merge.get("maxOverlapMs", 0)) <= OVERLAP_TOLERANCE_MS
    )


def _chars(metrics: dict[str, Any]) -> float:
    return float(metrics["charsProrated"])


def _fingerprint(text: str) -> str:
    return hashlib.sha256(normalize_for_cer(text).encode()).hexdigest()


def stability(base: Transcript, other: Transcript, cuts: Sequence[int]) -> dict[str, object]:
    """Share of baseline segments away from cuts found unchanged (text fingerprint, ±150 ms)."""
    far = [
        s
        for s in base.segments
        if all(abs((s.start_ms + s.end_ms) / 2 - c) > STABILITY_DISTANCE_MS for c in cuts)
    ]
    index: dict[str, list[tuple[int, int]]] = {}
    for s in other.segments:
        index.setdefault(_fingerprint(s.text), []).append((s.start_ms, s.end_ms))
    matched = sum(
        any(
            abs(start - s.start_ms) <= STABILITY_TOLERANCE_MS
            and abs(end - s.end_ms) <= STABILITY_TOLERANCE_MS
            for start, end in index.get(_fingerprint(s.text), [])
        )
        for s in far
    )
    share = round(matched / len(far), 4) if far else None
    return {"compared": len(far), "unchanged": matched, "share": share}


def compare(
    storage: Storage,
    baseline_id: str,
    run_ids: Sequence[str],
    reference_ids: Sequence[str] = (),
) -> dict[str, object]:
    base, base_text = load(storage, baseline_id)
    if base.chunking.overlap_ms != 0 or base_text is None or not valid(base):
        raise CompareError("The baseline must be a completed, valid run without overlap.")
    cuts = cuts_of(base)
    variants = [load(storage, run_id) for run_id in run_ids]
    references = [load(storage, run_id) for run_id in reference_ids]
    for result, _ in variants + references:
        if result.clip.id != base.clip.id:
            raise CompareError("All runs must be of the same clip.")
    for result, _ in variants:
        if result.chunking.target_seconds != base.chunking.target_seconds:
            raise CompareError("Variants must use the baseline's chunk target.")
        if result.status == "completed" and cuts_of(result) != cuts:
            raise CompareError("Variants must share the baseline's cuts.")

    windows: list[dict[str, Any]] = []
    for n, cut in enumerate(cuts, start=1):
        lo, hi = cut - WINDOW_HALF_MS, cut + WINDOW_HALF_MS
        refs: list[dict[str, Any]] = []
        for result, transcript in references:
            if transcript is None or not valid(result):
                continue
            near = any(lo <= c <= hi for c in cuts_of(result))
            refs.append(
                {
                    "run": label(result),
                    "role": "alt-also-cut" if near else "alt-no-cut",
                    **window_metrics(transcript, lo, hi),
                }
            )
        clean = [_chars(r) for r in refs if r["role"] == "alt-no-cut"]
        windows.append(
            {
                "window": f"W{n}",
                "baseline": window_metrics(base_text, lo, hi),
                "variants": {
                    label(result): window_metrics(transcript, lo, hi)
                    for result, transcript in variants
                    if transcript is not None
                },
                "references": refs,
                "noCutReferenceChars": statistics.median(clean) if clean else None,
            }
        )

    summaries = []
    for result, transcript in variants:
        name = label(result)
        is_valid = valid(result) and transcript is not None
        rows = [w for w in windows if name in w["variants"]]
        base_chars = sum(_chars(w["baseline"]) for w in rows)
        var_chars = sum(_chars(w["variants"][name]) for w in rows)
        improved = sum(_chars(w["variants"][name]) > _chars(w["baseline"]) for w in rows)
        with_ref = [w for w in rows if w["noCutReferenceChars"] is not None]
        ref_gap = sum(float(w["noCutReferenceChars"]) - _chars(w["baseline"]) for w in with_ref)
        gained = sum(_chars(w["variants"][name]) - _chars(w["baseline"]) for w in with_ref)
        change = round((var_chars - base_chars) / base_chars, 4) if base_chars else None
        closure = round(gained / ref_gap, 4) if with_ref and ref_gap > 0 else None
        stable = stability(base_text, transcript, cuts) if transcript is not None else None
        summaries.append(
            {
                "run": name,
                "status": result.status,
                "valid": is_valid,
                "comparableWindows": len(rows),
                "windowsImproved": improved,
                "baselineChars": round(base_chars, 1),
                "variantChars": round(var_chars, 1),
                "aggregateChange": change,
                "gapClosure": closure,
                "stability": stable,
                "overlap": result.overlap,
                "classification": classify(is_valid, len(rows), improved, change, closure, stable),
            }
        )
    return {
        "clip": base.clip.label,
        "baseline": label(base),
        "windowHalfMs": WINDOW_HALF_MS,
        "windows": windows,
        "variants": summaries,
    }


def classify(
    is_valid: bool,
    windows: int,
    improved: int,
    change: float | None,
    closure: float | None,
    stable: dict[str, object] | None,
) -> str:
    """The numeric part of the M1-B2 criteria; human review decides 'strong' and rejections."""
    if not is_valid:
        return "reject: timing validation failed"
    if windows < 2 or change is None:
        return "inconclusive: too few comparable windows"
    share = stable.get("share") if stable else None
    unstable = isinstance(share, float) and share < STABILITY_REQUIRED
    if change < REJECT_LOSS:
        verdict = "reject-candidate: fewer characters near cuts (pending human review)"
    elif improved * 2 > windows and change >= PROMISING_GAIN:
        verdict = "promising"
        if closure is not None and closure >= GAP_CLOSURE_STRONG:
            verdict += "; strong pending human review"
    else:
        verdict = "neutral/inconclusive: mixed or small differences"
    return verdict + ("; unstable away from cuts" if unstable else "")


def write(storage: Storage, comparison: dict[str, object]) -> Path:
    directory = bench_root(storage) / "reports"
    directory.mkdir(mode=PRIVATE_DIR, parents=True, exist_ok=True)
    make_private(directory)
    path = directory / f"compare-{datetime.now(UTC):%Y%m%dT%H%M%SZ}.json"
    path.write_text(json.dumps(comparison, indent=2), encoding="utf-8")
    make_private(path)
    return path
