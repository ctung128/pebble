"""
`bench report`: aggregates private run results into numbers only — no text, no paths. It writes
`<data>/benchmarks/reports/report-<time>.{json,md}` for later manual documentation and never
touches the repository's docs.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

from ..storage import PRIVATE_DIR, Storage, make_private
from .paths import RUN_ID, bench_root, run_dir, runs_root
from .results import RunResult
from .review import read_ratings


def load_runs(storage: Storage, run_ids: Sequence[str] = ()) -> list[RunResult]:
    if run_ids:
        directories = [run_dir(storage, run_id) for run_id in run_ids]
    else:
        root = runs_root(storage)
        directories = sorted(
            p for p in (root.iterdir() if root.is_dir() else []) if RUN_ID.match(p.name)
        )
    results = []
    for directory in directories:
        path = directory / "result.json"
        if path.is_symlink() or not path.is_file():
            continue
        results.append(RunResult.model_validate(json.loads(path.read_text(encoding="utf-8"))))
    return results


def summarize(storage: Storage, results: Sequence[RunResult]) -> list[dict[str, object]]:
    rows = []
    for result in results:
        segments = result.segments or {}
        flags = segments.get("flags", {})
        review_path = run_dir(storage, result.run_id) / "review.md"
        rows.append(
            {
                "runId": result.run_id,
                "clip": result.clip.label,
                "mode": result.mode,
                "status": result.status,
                "targetSeconds": result.chunking.target_seconds,
                "audioMs": result.clip.duration_ms,
                "chunks": result.chunks.get("count"),
                "forcedCuts": result.chunks.get("forcedCuts"),
                "silenceCuts": result.chunks.get("silenceCuts"),
                "segments": segments.get("count"),
                "medianSegmentMs": (segments.get("durationMs") or {}).get("median"),
                "flagShares": {name: value["share"] for name, value in flags.items()},
                "setup": result.setup.dump(),
                "job": result.job.dump(),
                "physFootprintJobPeakMB": _mb(result.memory.phys_footprint_job_peak_bytes),
                "rssMaxMB": _mb(result.memory.rss_max_bytes),
                "boundaries": (result.boundaries or {}).get("summary"),
                "cer": result.cer.dump() if result.cer else None,
                "networkAttempts": result.network.get("attempts"),
                "ratings": read_ratings(review_path)
                if review_path.is_file() and not review_path.is_symlink()
                else None,
            }
        )
    return rows


def write_report(storage: Storage, rows: Sequence[dict[str, object]]) -> Path:
    directory = bench_root(storage) / "reports"
    directory.mkdir(mode=PRIVATE_DIR, parents=True, exist_ok=True)
    make_private(directory)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    json_path = directory / f"report-{stamp}.json"
    json_path.write_text(json.dumps({"runs": list(rows)}, indent=2), encoding="utf-8")
    md_path = directory / f"report-{stamp}.md"
    md_path.write_text(render_markdown(rows), encoding="utf-8")
    for path in (json_path, md_path):
        make_private(path)
    return md_path


def render_markdown(rows: Sequence[dict[str, object]]) -> str:
    header = (
        "| Run | Clip | Mode | Target s | Chunks (forced/silence) | Segments | Median seg ms "
        "| Setup ms (verify/import/load) | Job ms | RTF | Footprint peak MB | CER |"
    )
    lines = [
        "# Benchmark report (private)",
        "",
        "Local measurements on this computer; not general performance or accuracy claims.",
        "",
        header,
        "|" + "---|" * (header.count("|") - 1),
    ]
    for row in rows:
        setup = row["setup"]  # type: ignore[index]
        job = row["job"]  # type: ignore[index]
        cer = row["cer"]
        lines.append(
            f"| {row['runId']} | {row['clip']} | {row['mode']} | {row['targetSeconds']:g} "
            f"| {row['chunks']} ({row['forcedCuts']}/{row['silenceCuts']}) | {row['segments']} "
            f"| {row['medianSegmentMs']} "
            f"| {setup['verificationMs']}/{setup['importMs']}/{setup['loadMs']} "  # type: ignore[index]
            f"| {job['totalMs']} | {job['realTimeFactor']} "  # type: ignore[index]
            f"| {row['physFootprintJobPeakMB']} "
            f"| {'' if cer is None else f'{cer["value"]} ({cer["kind"]})'} |"  # type: ignore[index]
        )
    return "\n".join(lines) + "\n"


def _mb(value: int | None) -> float | None:
    return None if value is None else round(value / 1e6, 1)
