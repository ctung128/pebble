"""`pebble-worker bench run|report|review`: argument handling and console output (numbers only)."""

from __future__ import annotations

import argparse
import os
from collections.abc import Sequence

from ..config import Settings
from ..errors import StorageAccessError
from ..health import display_path
from ..pipeline.probe import probe
from ..providers.funasr import FunASRProvider
from ..storage import Storage
from . import network
from .corpus import CorpusError, find_clip
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


def run_command(settings: Settings, args: argparse.Namespace) -> int:
    storage = Storage(settings.data_dir)
    if args.bench_action == "report":
        return report(storage, args.run)
    if args.bench_action == "review":
        return rebuild(storage, args.run)
    try:
        targets = [_target(value) for value in args.chunk]
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
    print(f"Benchmark: {bench_input.label} · {args.mode} · chunk targets: {plan}")
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
