"""`pebble-worker bench …`: argument handling and console output (numbers only)."""

from __future__ import annotations

import argparse
import json
import os
from collections.abc import Sequence

from ..config import Settings
from ..errors import StorageAccessError
from ..health import display_path
from ..pipeline.probe import probe
from ..providers.funasr import FunASRProvider
from ..storage import Storage
from . import compare, network, paired
from . import diarize as diarize_bench
from .corpus import CorpusError, find_clip
from .overlap import MAX_OVERLAP_MS
from .rebuild import RebuildError, rebuild_review
from .report import load_runs, summarize, write_report
from .runner import BenchInput, corpus_input, run_cold, synthetic_input, warm_session

#: A manifest duration further than this from the file's real duration is refused.
DURATION_TOLERANCE = 0.10


def add_parser(commands: argparse._SubParsersAction) -> None:  # type: ignore[type-arg]
    bench = commands.add_parser("bench", help="private FunASR benchmarks (docs/BENCHMARKS.md)")
    actions = bench.add_subparsers(dest="bench_action", required=True)

    run = actions.add_parser("run", help="benchmark one clip at the chunk targets you list")
    source = run.add_mutually_exclusive_group(required=True)
    source.add_argument("--clip", help="clip id from ~/.pebble/benchmarks/corpus.json")
    source.add_argument(
        "--synthetic", action="store_true", help="invented sentences spoken by macOS `say`"
    )
    run.add_argument(
        "--chunk",
        action="append",
        required=True,
        metavar="SECONDS|default",
        help="target chunk length; repeat for each target to run (no implicit matrix)",
    )
    run.add_argument("--mode", choices=("warm", "cold"), default="warm")
    run.add_argument(
        "--overlap-ms",
        action="append",
        type=int,
        metavar="MS",
        help="benchmark-only shared audio overlap at each cut (0-2000); repeat for one run "
        "each, with a single --chunk (M1-B2)",
    )
    run.add_argument("--seed", type=int, default=7, help="seed for choosing review controls")
    run.add_argument(
        "--dry-run", action="store_true", help="validate the clip and print the plan only"
    )

    report = actions.add_parser("report", help="aggregate private results (numbers only)")
    report.add_argument("--run", action="append", default=[], metavar="RUN_ID")

    review = actions.add_parser(
        "review", help="rebuild a run's private review checklist (no transcription)"
    )
    review.add_argument("--run", action="append", required=True, metavar="RUN_ID")

    compare = actions.add_parser(
        "compare", help="overlap variants against a baseline, numbers only (M1-B2)"
    )
    compare.add_argument("--baseline", required=True, metavar="RUN_ID")
    compare.add_argument("--run", action="append", required=True, metavar="RUN_ID")
    compare.add_argument(
        "--reference",
        action="append",
        default=[],
        metavar="RUN_ID",
        help="same clip at another chunk target, for no-cut comparison windows",
    )

    pair = actions.add_parser("pair", help="write a private blinded paired review (M1-B2)")
    pair.add_argument("--baseline", required=True, metavar="RUN_ID")
    pair.add_argument("--run", action="append", required=True, metavar="RUN_ID")
    pair.add_argument("--seed", type=int, default=7)

    tally = actions.add_parser("tally", help="count a paired review's ticks (numbers only)")
    tally.add_argument("name", metavar="overlap-<time>.md")

    diarize = actions.add_parser(
        "diarize",
        help="speaker diarization evaluation on one named local episode (ADR 0009)",
    )
    diarize.add_argument(
        "--episode", required=True, metavar="EPISODE_ID", help="an episode you chose, e.g. ep-…"
    )
    diarize.add_argument(
        "--speakers",
        type=int,
        metavar="N",
        help="also cluster with this speaker-count hint (the auto configuration always runs)",
    )
    diarize.add_argument(
        "--lines",
        type=int,
        default=diarize_bench.DEFAULT_LINES,
        help=f"lines to review ({diarize_bench.MIN_LINES}-{diarize_bench.MAX_LINES})",
    )
    diarize.add_argument(
        "--seed",
        type=int,
        default=7,
        help="auto runs use SEED, SEED+1 and SEED+2; the hint run and the review sample use SEED",
    )
    diarize.add_argument(
        "--deadline-minutes",
        type=float,
        default=diarize_bench.DEFAULT_DEADLINE_MINUTES,
        help=f"hard limit for the whole run ({diarize_bench.MIN_DEADLINE_MINUTES}-"
        f"{diarize_bench.MAX_DEADLINE_MINUTES}); on expiry partial files are removed",
    )
    diarize.add_argument(
        "--dry-run",
        action="store_true",
        help="print counts and the clustering path only; no model, no audio",
    )

    diarize_score = actions.add_parser(
        "diarize-score", help="score a reviewed diarization run (numbers only)"
    )
    diarize_score.add_argument("--run", required=True, metavar="RUN_ID")

    targeted = actions.add_parser(
        "diarize-targeted",
        help="blind check of a scored run's unmatched clusters (no audio, model or database)",
    )
    targeted.add_argument("--run", required=True, metavar="RUN_ID")
    targeted.add_argument(
        "--score", action="store_true", help="count the filled-in targeted sheet (numbers only)"
    )


def run_command(settings: Settings, args: argparse.Namespace) -> int:
    storage = Storage(settings.data_dir)
    if args.bench_action == "report":
        return report(storage, args.run)
    if args.bench_action == "review":
        return rebuild(storage, args.run)
    if args.bench_action in ("compare", "pair", "tally"):
        return experiment(storage, args)
    if args.bench_action in ("diarize", "diarize-score", "diarize-targeted"):
        return diarize(storage, settings, args)
    try:
        targets = [_target(value) for value in args.chunk]
        overlaps = _overlaps(args.overlap_ms, targets, args.mode)
    except ValueError as error:
        print(f"pebble-worker bench: {error}")
        return 2
    try:
        bench_input = (
            synthetic_input() if args.synthetic else _checked_clip(storage, settings, args.clip)
        )
    except CorpusError as error:
        print(f"pebble-worker bench: {error}")
        return 2

    plan = ", ".join("default" if t is None else f"{t} s" for t in targets)
    extra = " · overlap: " + ", ".join(f"{o} ms" for o in overlaps) if overlaps != [0] else ""
    print(f"Benchmark: {bench_input.label} · {args.mode} · chunk targets: {plan}{extra}")
    if args.dry_run:
        print("Dry run: the clip is valid. Nothing was transcribed.")
        return 0

    network.block_network()
    if args.mode == "cold":
        env = {**os.environ, "PEBBLE_DATA_DIR": str(settings.data_dir)}
        directories = [
            run_cold(storage, bench_input.clip_id, target, args.seed, env) for target in targets
        ]
    else:
        directories = warm_session(
            storage,
            settings,
            bench_input,
            targets,
            provider=FunASRProvider(storage),
            seed=args.seed,
            overlaps=overlaps,
        )
    for directory in directories:
        print(f"  {directory.name} → {display_path(directory)}")
    print("Results, transcript and review checklist are private to that folder.")
    if network.attempts():
        print(f"Warning: {network.attempts()} network attempt(s) were blocked.")
    return 0


def report(storage: Storage, run_ids: Sequence[str]) -> int:
    results = load_runs(storage, run_ids)
    if not results:
        print("No benchmark runs yet.")
        return 1
    rows = summarize(storage, results)
    for row in rows:
        job, setup = row["job"], row["setup"]
        print(
            f"{row['runId']}: {row['clip']} · {row['mode']} · {row['targetSeconds']:g} s · "
            f"{row['status']} · {row['segments']} segments · "
            f"setup {setup['verificationMs']}/{setup['importMs']}/{setup['loadMs']} ms · "  # type: ignore[index]
            f"job {job['totalMs']} ms · RTF {job['realTimeFactor']} · "  # type: ignore[index]
            f"peak {row['physFootprintJobPeakMB']} MB"
        )
    path = write_report(storage, rows)
    print(f"Private report: {display_path(path)}")
    return 0


def rebuild(storage: Storage, run_ids: Sequence[str]) -> int:
    network.block_network()
    status = 0
    for run_id in run_ids:
        try:
            counts = rebuild_review(storage, run_id)
        except (RebuildError, StorageAccessError) as error:
            print(f"pebble-worker bench: {error}")
            status = 2
            continue
        selection = ", ".join(f"{name} {count}" for name, count in counts.items())
        print(f"{run_id}: {sum(counts.values())} segments ({selection})")
    if status == 0:
        print("Review checklists rebuilt from saved transcripts; nothing was transcribed.")
    return status


def experiment(storage: Storage, args: argparse.Namespace) -> int:
    """`compare`, `pair` and `tally`: saved artifacts only; prints numbers and labels only."""
    network.block_network()
    try:
        if args.bench_action == "compare":
            result = compare.compare(storage, args.baseline, args.run, args.reference)
            for window in result["windows"]:
                chars = ", ".join(
                    f"{name} {m['charsProrated']}" for name, m in window["variants"].items()
                )
                print(
                    f"{window['window']}: baseline {window['baseline']['charsProrated']} · "
                    f"{chars} · no-cut reference {window['noCutReferenceChars']}"
                )
            for row in result["variants"]:
                print(
                    f"{row['run']}: improved {row['windowsImproved']}/{row['comparableWindows']}"
                    f" · change {row['aggregateChange']} · gap closure {row['gapClosure']} · "
                    f"stability {(row['stability'] or {}).get('share')} · {row['classification']}"
                )
            print(f"Private comparison: {display_path(compare.write(storage, result))}")
        elif args.bench_action == "pair":
            review = paired.create(storage, args.baseline, args.run, seed=args.seed)
            print(f"Private paired review: {display_path(review.path)} (key kept separately)")
            affected = ", ".join(review.affected) or "none"
            print(f"{review.items} items; decided by the earlier resolver rule: {affected}")
        else:
            counts = paired.tally(storage, args.name)
            print(json.dumps(counts, indent=2))
    except (compare.CompareError, StorageAccessError) as error:
        print(f"pebble-worker bench: {error}")
        return 2
    print("Read from saved results only; nothing was transcribed.")
    return 0


def diarize(storage: Storage, settings: Settings, args: argparse.Namespace) -> int:
    """Prints numbers only; the private run folder holds the review sheet."""
    network.block_network()
    try:
        if args.bench_action == "diarize-targeted":
            if args.score:
                scored = diarize_bench.score_targeted(storage, args.run)
                print(
                    json.dumps(
                        {k: scored[k] for k in ("kind", "invalidRows", "clusters")}, indent=2
                    )
                )
            else:
                print(json.dumps(diarize_bench.prepare_targeted(storage, args.run), indent=2))
                print("Fill in targeted-review.md in the run folder (private).")
            return 0
        if args.bench_action == "diarize-score":
            scored = diarize_bench.score_run(storage, args.run)
            print(
                json.dumps(
                    {k: scored[k] for k in ("reviewed", "configs", "proposedTargets")}, indent=2
                )
            )
            print("Scored from saved results and your review; nothing was processed again.")
            return 0
        if args.dry_run:
            episode = diarize_bench.load_episode(storage, args.episode)
            summary = {
                **diarize_bench.plan(episode, args.speakers),
                "audio": diarize_bench.audio_status(storage, episode),
            }
            print(json.dumps(summary, indent=2))
            print(
                "Dry run: no model was loaded and no audio was read. Window counts are from the "
                "stored line times; the run reports the counts it actually embeds."
            )
            return 0
        directory = diarize_bench.run_bounded(
            storage,
            settings,
            args.episode,
            hint=args.speakers,
            lines=args.lines,
            seed=args.seed,
            deadline_minutes=args.deadline_minutes,
        )
    except (diarize_bench.DiarizeError, StorageAccessError) as error:
        print(f"pebble-worker bench: {error}")
        return 2
    result = json.loads((directory / "result.json").read_text(encoding="utf-8"))
    print(
        json.dumps(
            {k: result[k] for k in ("windows", "timingsMs", "configs", "performance")}, indent=2
        )
    )
    print(f"  {directory.name} → {display_path(directory)}")
    print("Review review.md there (private), then run: bench diarize-score --run " + directory.name)
    if network.attempts():
        print(f"Warning: {network.attempts()} network attempt(s) were blocked.")
    return 0


def _overlaps(values: list[int] | None, targets: list[int | None], mode: str) -> list[int]:
    overlaps = values or [0]
    if any(not 0 <= o <= MAX_OVERLAP_MS for o in overlaps):
        raise ValueError(f"Overlaps must be between 0 and {MAX_OVERLAP_MS} ms.")
    if len(set(overlaps)) != len(overlaps):
        raise ValueError("List each overlap once.")
    if len(overlaps) > 1 and len(targets) > 1:
        raise ValueError("Several overlaps need a single --chunk target (no implicit matrix).")
    if mode == "cold" and overlaps != [0]:
        raise ValueError("Overlap runs are warm only.")
    return overlaps


def _target(value: str) -> int | None:
    if value == "default":
        return None
    seconds = int(value) if value.isdigit() else -1
    if not 10 <= seconds <= 900:
        raise ValueError("Chunk targets must be between 10 and 900 seconds, or 'default'.")
    return seconds


def _checked_clip(storage: Storage, settings: Settings, clip_id: str) -> BenchInput:
    clip = find_clip(storage, clip_id)
    measured = probe(
        clip.path, ffprobe=settings.ffprobe_path, max_seconds=settings.max_audio_seconds
    ).duration_ms
    expected = clip.duration_seconds * 1000
    if abs(measured - expected) > expected * DURATION_TOLERANCE:
        raise CorpusError(
            f"{clip.id}: durationSeconds doesn't match the file (off by more than "
            f"{DURATION_TOLERANCE:.0%}). Check that the path points to the intended clip."
        )
    return corpus_input(clip)
