"""Benchmark locations. Every path is inside `<data>/benchmarks`, free of symlinks."""

from __future__ import annotations

import re
from pathlib import Path

from ..errors import StorageAccessError
from ..models.verify import first_symlink
from ..storage import PRIVATE_DIR, Storage, make_private

BENCH_DIRNAME = "benchmarks"
RUN_ID = re.compile(r"^\d{8}T\d{6}Z-[a-z0-9][a-z0-9-]{0,40}-\d{1,4}s-(warm|cold)(-o\d{1,4})?$")


def bench_root(storage: Storage) -> Path:
    return _safe(storage, storage.root / BENCH_DIRNAME)


def corpus_path(storage: Storage) -> Path:
    return _safe(storage, storage.root / BENCH_DIRNAME / "corpus.json")


def runs_root(storage: Storage) -> Path:
    return _safe(storage, storage.root / BENCH_DIRNAME / "runs")


def run_dir(storage: Storage, run_id: str) -> Path:
    if not RUN_ID.match(run_id):
        raise StorageAccessError(f"Invalid benchmark run id: {run_id!r}")
    return _safe(storage, storage.root / BENCH_DIRNAME / "runs" / run_id)


#: The only files a run directory holds (plus a temporary file while review.md is rewritten).
RUN_FILES = (
    "result.json",
    "transcript.json",
    "review.md",
    "normalized.wav",
    "overlap.json",
    "review.md.tmp",
)


def run_file(storage: Storage, run_id: str, name: str) -> Path:
    if name not in RUN_FILES:
        raise StorageAccessError(f"Unknown benchmark run file: {name!r}")
    return _safe(storage, run_dir(storage, run_id) / name)


def create_run_dir(storage: Storage, run_id: str) -> Path:
    """Creates a new, private run directory; refuses to reuse an existing one."""
    storage.ensure()
    for directory in (bench_root(storage), runs_root(storage)):
        directory.mkdir(mode=PRIVATE_DIR, exist_ok=True)
        make_private(directory)
    path = run_dir(storage, run_id)
    path.mkdir(mode=PRIVATE_DIR)  # FileExistsError if it exists
    make_private(path)
    return path


def _safe(storage: Storage, path: Path) -> Path:
    symlink = first_symlink(storage, path)
    if symlink is not None:
        raise StorageAccessError(f"Benchmark paths may not go through a symlink: {symlink}")
    storage.contain(path)
    return path
