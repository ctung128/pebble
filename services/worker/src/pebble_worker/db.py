"""SQLite persistence with numbered migrations (tracked in PRAGMA user_version)."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from .storage import make_private

MIGRATIONS: list[str] = [
    # 1 — initial schema
    """
    CREATE TABLE episodes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      source_path TEXT NOT NULL,              -- relative to the data directory
      mime_type TEXT NOT NULL,
      duration_ms INTEGER,                    -- known after normalizing
      language TEXT NOT NULL DEFAULT 'zh-CN',
      ownership_confirmed_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      episode_id TEXT NOT NULL UNIQUE REFERENCES episodes(id) ON DELETE CASCADE,
      status TEXT NOT NULL
        CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      stage TEXT
        CHECK (stage IN ('probing', 'normalizing', 'chunking', 'transcribing', 'merging')),
      attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
      provider_id TEXT NOT NULL,
      provider_kind TEXT NOT NULL CHECK (provider_kind IN ('mock', 'asr')),
      total_chunks INTEGER,
      completed_chunks INTEGER,
      failure TEXT,                           -- JSON {stage, code, message, retryable, hint}
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX jobs_by_status ON jobs (status, created_at);

    -- One row per chunk per attempt. Rows from earlier attempts are kept (never merged).
    CREATE TABLE chunks (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      cut TEXT NOT NULL CHECK (cut IN ('silence', 'hard', 'end')),
      path TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'cancelled')),
      segments TEXT,                          -- JSON provider output, chunk-relative times
      updated_at TEXT NOT NULL,
      PRIMARY KEY (job_id, attempt, idx)
    );

    -- Written only after a complete, validated merge.
    CREATE TABLE transcripts (
      episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL,
      body TEXT NOT NULL,                     -- JSON, validated transcript contract
      created_at TEXT NOT NULL
    );
    """,
]


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        """One short-lived connection per unit of work; commits on success."""
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    @property
    def schema_version(self) -> int:
        with self.tx() as conn:
            return int(conn.execute("PRAGMA user_version").fetchone()[0])

    def migrate(self) -> int:
        conn = sqlite3.connect(self.path)
        try:
            conn.execute("PRAGMA journal_mode = WAL")
            version = int(conn.execute("PRAGMA user_version").fetchone()[0])
            for number, sql in enumerate(MIGRATIONS[version:], start=version + 1):
                conn.executescript(f"BEGIN; {sql}; PRAGMA user_version = {number}; COMMIT;")
        finally:
            conn.close()
        make_private(self.path)
        return len(MIGRATIONS)
