"""
Blinded paired review for the overlap experiment (M1-B2): `bench pair` and `bench tally`.

`bench pair` writes `<data>/benchmarks/reviews/overlap-<time>.md` (private: recognized text and
replay commands) and a separate private key, `overlap-<time>.key.json`, mapping each item's
letters (X, Y, Z…) to runs in a seeded random order. Items: every cut window, each variant's
private conflict/ambiguity/possible-repeat items, and five controls away from cuts.

`bench tally` reads the ticks back as counts per run, revealing the key only in those counts.
Every rating row takes exactly one tick; rows with none are unrated, rows with several invalid.
"""

from __future__ import annotations

import json
import random
import re
import shlex
import string
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..contract import Transcript
from ..errors import StorageAccessError
from ..storage import PRIVATE_DIR, Storage, make_private
from .analysis import WINDOW_HALF_MS, normalize_for_cer
from .compare import CompareError, cuts_of, label, load, valid
from .paths import bench_root, run_file, safe_path
from .results import RunResult

CONTROLS = 5
STABILITY_DISTANCE_MS = 10_000
MAX_FLAGGED_ITEMS = 10
REVIEW_NAME = re.compile(r"^overlap-\d{8}T\d{6}Z\.md$")

ROWS: dict[str, tuple[str, ...]] = {
    "Replay range": ("clean", "clipped start", "clipped end", "extra speech"),
    "Text quality": ("fine", "minor fix", "major fix"),
    "Missing speech": ("yes", "no"),
    "Duplicate speech": ("yes", "no"),
    "Effort": ("none", "under 15 s", "15-60 s", "over 60 s or gave up"),
}
NO_DIFFERENCE = "no clear difference"

_ITEM = re.compile(r"^### (P\d{2}) ", re.M)
_VARIANT = re.compile(r"^#### ([A-Z])\s*$", re.M)
_BOX = re.compile(r"\[([ xX])\] ([^\[]+?)\s*(?=\[|$)")


def reviews_dir(storage: Storage) -> Path:
    return safe_path(storage, bench_root(storage) / "reviews")


def review_path(storage: Storage, name: str) -> Path:
    if not REVIEW_NAME.match(name):
        raise StorageAccessError(f"Invalid paired review name: {name!r}")
    return safe_path(storage, reviews_dir(storage) / name)


def _clock(ms: int) -> str:
    return f"{ms // 60000}:{ms % 60000 / 1000:06.3f}"


def _boxes(options: Sequence[str]) -> str:
    return "  ".join(f"[ ] {option}" for option in options)


def _old_resolver(result: RunResult) -> bool:
    """Runs resolved before the punctuation-only rule (resolver version 1)."""
    return result.overlap is not None and int(result.overlap.get("resolverVersion", 1)) < 2


def _punctuation_only_inside(transcript: Transcript, lo: int, hi: int) -> bool:
    return any(
        s.end_ms > lo and s.start_ms < hi and not normalize_for_cer(s.text)
        for s in transcript.segments
    )


def _items(
    storage: Storage,
    base_text: Transcript,
    cuts: Sequence[int],
    variants: Sequence[tuple[str, RunResult, Transcript]],
    seed: int,
) -> list[dict[str, Any]]:
    """
    Cut windows, then each variant's flagged items (folded into an item they overlap), then
    seeded controls away from cuts. A stored conflict decided by resolver version 1 in favour of
    a punctuation-only segment marks its item `affected`.
    """
    items: list[dict[str, Any]] = [
        {
            "why": f"cut window W{n}",
            "lo": c - WINDOW_HALF_MS,
            "hi": c + WINDOW_HALF_MS,
            "includes": Counter(),
            "affected": False,
        }
        for n, c in enumerate(cuts, start=1)
    ]
    flagged = 0
    for run_id, result, transcript in variants:
        path = run_file(storage, run_id, "overlap.json")
        if not path.is_file():
            continue
        for entry in json.loads(path.read_text(encoding="utf-8")).get("reviewItems", []):
            lo, hi, kind = int(entry["startMs"]), int(entry["endMs"]), str(entry["kind"])
            affected = (
                kind == "conflict"
                and _old_resolver(result)
                and _punctuation_only_inside(transcript, lo, hi)
            )
            host = next((i for i in items if i["lo"] < hi and lo < i["hi"]), None)
            if host is None:
                if flagged >= MAX_FLAGGED_ITEMS:
                    continue
                host = {"why": kind, "lo": lo, "hi": hi, "includes": Counter(), "affected": False}
                items.append(host)
                flagged += 1
            host["includes"][kind] += 1
            host["affected"] = host["affected"] or affected
    pool = [
        s
        for s in base_text.segments
        if not (s.review and s.review.flags)
        and all(abs((s.start_ms + s.end_ms) / 2 - c) > STABILITY_DISTANCE_MS for c in cuts)
    ]
    for s in random.Random(f"{seed}:paired-control").sample(pool, min(CONTROLS, len(pool))):
        items.append(
            {
                "why": "control",
                "lo": s.start_ms,
                "hi": s.end_ms,
                "includes": Counter(),
                "affected": False,
            }
        )
    items.sort(key=lambda i: i["lo"])
    return items


@dataclass(frozen=True)
class PairedReview:
    path: Path
    items: int
    affected: tuple[str, ...]  # anonymous item ids decided by the pre-fix resolver
    pre_fix: bool


def create(
    storage: Storage, baseline_id: str, variant_ids: Sequence[str], *, seed: int
) -> PairedReview:
    base, base_text = load(storage, baseline_id)
    if base_text is None or base.chunking.overlap_ms != 0 or not valid(base):
        raise CompareError("The baseline must be a completed, valid run without overlap.")
    cuts = cuts_of(base)
    runs: list[tuple[str, Transcript]] = [(label(base), base_text)]
    variants: list[tuple[str, RunResult, Transcript]] = []
    for run_id in variant_ids:
        result, transcript = load(storage, run_id)
        if result.clip.id != base.clip.id or transcript is None or cuts_of(result) != cuts:
            raise CompareError("Variants must be completed runs of the same clip and cuts.")
        runs.append((label(result), transcript))
        variants.append((run_id, result, transcript))
    pre_fix = any(_old_resolver(result) for _, result, _ in variants)
    if len({name for name, _ in runs}) != len(runs):
        raise CompareError("List each variant once.")
    audio = run_file(storage, baseline_id, "normalized.wav")
    items = _items(storage, base_text, cuts, variants, seed)
    letters = "XYZ" if len(runs) <= 3 else string.ascii_uppercase
    key: dict[str, dict[str, str]] = {}
    lines = [
        f"# Paired overlap review — {base.clip.label}",
        "",
        "Private: recognized text and local paths. Keep it under ~/.pebble; never share it.",
        "Versions are shown in a random order per item; the key is in a separate private file.",
        "Tick exactly one box per row (`[x]`). `bench tally` counts the ticks.",
        "",
    ]
    if pre_fix:
        lines += [
            "Stored outputs: these overlap runs were resolved before the punctuation-only fix",
            "(resolver version 1) and are shown unchanged. Items marked 'decided by the",
            "earlier rule' contain a conflict where a punctuation-only segment was kept over",
            "one with text.",
            "",
        ]
    affected: list[str] = []
    for n, item in enumerate(items, start=1):
        item_id = f"P{n:02d}"
        if item["affected"]:
            affected.append(item_id)
        order = list(range(len(runs)))
        random.Random(f"{seed}:{item_id}").shuffle(order)
        key[item_id] = {letters[pos]: runs[run][0] for pos, run in enumerate(order)}
        lo, hi = max(0, item["lo"]), item["hi"]
        replay = (
            f"ffplay -nodisp -autoexit -loglevel error -nostats -ss {lo / 1000:.3f} "
            f"-t {(hi - lo) / 1000:.3f} {shlex.quote(str(audio))}"
        )
        lines += [
            f"### {item_id} · {_clock(lo)}–{_clock(hi)} · {_why(item)}",
            "",
            f"- Replay: `{replay}`",
            f"- Best version: {_boxes([*letters[: len(runs)], NO_DIFFERENCE])}",
            "",
        ]
        for pos, run in enumerate(order):
            transcript = runs[run][1]
            inside = [s for s in transcript.segments if s.end_ms > lo and s.start_ms < hi]
            lines += [f"#### {letters[pos]}", ""]
            lines += [f"- {_clock(s.start_ms)}–{_clock(s.end_ms)}: {s.text}" for s in inside] or [
                "- (no text in this range)"
            ]
            lines += [f"- {row}: {_boxes(options)}" for row, options in ROWS.items()]
            lines.append("")
    directory = reviews_dir(storage)
    directory.mkdir(mode=PRIVATE_DIR, exist_ok=True)
    make_private(directory)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    path = review_path(storage, f"overlap-{stamp}.md")
    if path.exists():
        raise CompareError("A paired review with this timestamp already exists; try again.")
    path.write_text("\n".join(lines), encoding="utf-8")
    make_private(path)
    key_path = safe_path(storage, directory / f"overlap-{stamp}.key.json")
    key_path.write_text(json.dumps({"seed": seed, "items": key}, indent=2), encoding="utf-8")
    make_private(key_path)
    return PairedReview(path, len(items), tuple(affected), pre_fix)


def _why(item: dict[str, Any]) -> str:
    parts = [item["why"]]
    extra = {k: n for k, n in item["includes"].items() if not (k == item["why"] and n == 1)}
    if extra:
        parts.append("includes " + ", ".join(f"{k} x{n}" for k, n in sorted(extra.items())))
    if item["affected"]:
        parts.append("decided by the earlier rule")
    return " · ".join(parts)


def _ticked(line: str) -> list[str]:
    return [option for mark, option in _BOX.findall(line) if mark in "xX"]


def tally(storage: Storage, name: str) -> dict[str, Any]:
    """Counts per run (from the key) — never any text from the review file."""
    path = review_path(storage, name)
    key_path = safe_path(storage, reviews_dir(storage) / name.replace(".md", ".key.json"))
    if not path.is_file() or not key_path.is_file():
        raise CompareError("No such paired review.")
    key: dict[str, dict[str, str]] = json.loads(key_path.read_text(encoding="utf-8"))["items"]
    runs = sorted({run for mapping in key.values() for run in mapping.values()})
    counts: dict[str, dict[str, dict[str, int]]] = {
        run: {row: dict.fromkeys(options, 0) for row, options in ROWS.items()} for run in runs
    }
    best = dict.fromkeys([*runs, NO_DIFFERENCE], 0)
    unrated = invalid = 0
    parts = _ITEM.split(path.read_text(encoding="utf-8"))[1:]
    for item_id, body in zip(parts[0::2], parts[1::2], strict=True):
        mapping = key.get(item_id, {})
        head, *blocks = _VARIANT.split(body)
        for line in head.splitlines():
            if line.startswith("- Best version:"):
                ticked = _ticked(line)
                if len(ticked) == 1 and (ticked[0] in mapping or ticked[0] == NO_DIFFERENCE):
                    best[mapping.get(ticked[0], NO_DIFFERENCE)] += 1
                elif ticked:
                    invalid += 1
                else:
                    unrated += 1
        for letter, block in zip(blocks[0::2], blocks[1::2], strict=True):
            run = mapping.get(letter)
            if run is None:
                continue
            for line in block.splitlines():
                for row, options in ROWS.items():
                    if line.startswith(f"- {row}:"):
                        ticked = [t for t in _ticked(line) if t in options]
                        if len(ticked) == 1:
                            counts[run][row][ticked[0]] += 1
                        elif ticked:
                            invalid += 1
                        else:
                            unrated += 1
    return {
        "items": len(parts) // 2,
        "runs": counts,
        "bestVersion": best,
        "unratedRows": unrated,
        "invalidRows": invalid,
    }
