"""The Pebble data directory. Every path the worker touches is resolved and contained here."""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

from .errors import StorageAccessError

EPISODE_ID = re.compile(r"^ep-[0-9a-f]{12}$")
PRIVATE_DIR = 0o700
PRIVATE_FILE = 0o600


def make_private(path: Path) -> None:
    os.chmod(path, PRIVATE_DIR if path.is_dir() else PRIVATE_FILE)


class Storage:
    """
    Layout (all private to the current user):

        <data_dir>/pebble.db                      SQLite: episodes, jobs, chunks, transcripts
        <data_dir>/logs/worker.log                job transitions (no audio content)
        <data_dir>/tmp/                           upload spool, deleted after each request
        <data_dir>/episodes/<id>/source.<ext>     the audio you provided
        <data_dir>/episodes/<id>/work/            normalized WAV + chunks for the current attempt
    """

    def __init__(self, data_dir: Path) -> None:
        self.root = data_dir.expanduser().resolve()

    @property
    def db_path(self) -> Path:
        return self.root / "pebble.db"

    @property
    def log_path(self) -> Path:
        return self.root / "logs" / "worker.log"

    @property
    def tmp_dir(self) -> Path:
        return self.root / "tmp"

    def ensure(self) -> None:
        for directory in (self.root, self.root / "episodes", self.root / "logs", self.tmp_dir):
            directory.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR)
            make_private(directory)

    def contain(self, path: Path) -> Path:
        """Resolves symlinks and `..`; refuses anything outside the data directory."""
        resolved = path.resolve()
        if not resolved.is_relative_to(self.root):
            raise StorageAccessError(f"Path is outside the Pebble data directory: {path}")
        return resolved

    def episode_dir(self, episode_id: str) -> Path:
        if not EPISODE_ID.match(episode_id):
            raise StorageAccessError(f"Invalid episode id: {episode_id!r}")
        return self.contain(self.root / "episodes" / episode_id)

    def work_dir(self, episode_id: str) -> Path:
        return self.contain(self.episode_dir(episode_id) / "work")

    def resolve_relative(self, relative: str) -> Path:
        """Resolves a path stored in the database (always relative to the data directory)."""
        if Path(relative).is_absolute():
            raise StorageAccessError("Stored paths must be relative.")
        return self.contain(self.root / relative)

    def relative(self, path: Path) -> str:
        return str(self.contain(path).relative_to(self.root))

    def reset_work_dir(self, episode_id: str) -> Path:
        work = self.work_dir(episode_id)
        if work.exists():
            shutil.rmtree(work)
        work.mkdir(parents=True, mode=PRIVATE_DIR)
        (work / "chunks").mkdir(mode=PRIVATE_DIR)
        return work

    def remove_episode(self, episode_id: str) -> None:
        directory = self.episode_dir(episode_id)
        if directory.exists():
            shutil.rmtree(directory)
