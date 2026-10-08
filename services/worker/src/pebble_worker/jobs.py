"""
Jobs: persistence, the state machine, and the single background runner.

State machine (status / stage):

    queued ──► running (probing → normalizing → chunking → transcribing → merging) ──► completed
       │            │
       │            ├─ PipelineError ───────────────────────────────────────────────► failed
       │            └─ cancel requested (checked between steps and while tools run) ─► cancelled
       └─ cancel ─────────────────────────────────────────────────────────────────► cancelled

    failed (retryable) / cancelled ── retry ──► queued (attempt + 1)
    running when the worker starts  ──────────► failed (WORKER_RESTARTED, retryable)

Retry restarts the pipeline from the source audio (the known-safe checkpoint): the work
directory is cleared and probe, normalize, chunk, transcribe and merge all run again.
Chunk rows from earlier attempts are kept for diagnosis and future resume support, but merge
only ever reads the current attempt, and only when every chunk of it is done.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import uuid
from collections import deque
from dataclasses import asdict, dataclass
from typing import TYPE_CHECKING, Any

from .config import Settings
from .contract import CURRENT_SCHEMA_VERSION, Job, JobStage, parse_job, require_valid
from .db import Database, now_iso
from .errors import Cancelled, FailureCode, PipelineError
from .pipeline.chunk import check_chunk_spans, detect_silences, plan_chunks, write_chunks
from .pipeline.merge import ChunkResult, merge_with_report
from .pipeline.normalize import normalize
from .pipeline.probe import probe
from .providers.base import AudioChunk, RawSegment, TranscriptionProvider
from .storage import Storage

if TYPE_CHECKING:
    from .speakers.service import SpeakerWork

log = logging.getLogger("pebble.jobs")

ACTIVE_STATUSES = ("queued", "running")


@dataclass(frozen=True)
class Failure:
    stage: JobStage | None
    code: str
    message: str
    retryable: bool
    hint: str | None

    @classmethod
    def from_error(cls, stage: JobStage | None, error: PipelineError) -> Failure:
        return cls(stage, error.code.value, error.message, bool(error.retryable), error.hint)


class JobConflict(Exception):
    """The requested transition isn't allowed from the job's current state."""


class JobService:
    """All job/episode state changes go through here."""

    def __init__(self, db: Database, provider: TranscriptionProvider) -> None:
        self.db = db
        self.provider = provider

    # --- creation & reads ---------------------------------------------------------------

    def create(self, conn: sqlite3.Connection, episode_id: str) -> str:
        job_id = f"job-{uuid.uuid4().hex[:12]}"
        stamp = now_iso()
        conn.execute(
            """INSERT INTO jobs (id, episode_id, status, attempt, provider_id, provider_kind,
                                 created_at, updated_at)
               VALUES (?, ?, 'queued', 1, ?, ?, ?, ?)""",
            (job_id, episode_id, self.provider.id, self.provider.kind, stamp, stamp),
        )
        return job_id

    def get(self, job_id: str) -> Job | None:
        with self.db.tx() as conn:
            row = conn.execute(_JOB_SELECT + " WHERE j.id = ?", (job_id,)).fetchone()
        return _to_contract(row) if row else None

    def list(self) -> list[Job]:
        with self.db.tx() as conn:
            rows = conn.execute(_JOB_SELECT + " ORDER BY j.created_at DESC").fetchall()
        return [_to_contract(row) for row in rows]

    def queued_ids(self) -> list[str]:
        with self.db.tx() as conn:
            rows = conn.execute(
                "SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at"
            ).fetchall()
        return [row["id"] for row in rows]

    # --- transitions --------------------------------------------------------------------

    def request_cancel(self, job_id: str) -> Job:
        with self.db.tx() as conn:
            row = conn.execute("SELECT status FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if row is None:
                raise KeyError(job_id)
            if row["status"] == "queued":
                failure = Failure(
                    None,
                    FailureCode.CANCELLED.value,
                    "Cancelled before it started.",
                    True,
                    "Retry to process this audio.",
                )
                conn.execute(
                    """UPDATE jobs SET status = 'cancelled', failure = ?, updated_at = ?
                       WHERE id = ?""",
                    (json.dumps(asdict(failure)), now_iso(), job_id),
                )
            elif row["status"] == "running":
                # The runner stops at its next checkpoint and records the cancellation.
                conn.execute(
                    "UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?",
                    (now_iso(), job_id),
                )
            else:
                raise JobConflict(f"Job is {row['status']}; only active jobs can be cancelled.")
        job = self.get(job_id)
        assert job is not None
        return job

    def retry(self, job_id: str) -> Job:
        with self.db.tx() as conn:
            row = conn.execute(
                "SELECT status, failure FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
            if row is None:
                raise KeyError(job_id)
            failure = json.loads(row["failure"]) if row["failure"] else None
            retryable = row["status"] == "cancelled" or (
                row["status"] == "failed" and failure is not None and failure["retryable"]
            )
            if not retryable:
                raise JobConflict(f"Job is {row['status']} and can't be retried.")
            conn.execute(
                """UPDATE jobs SET status = 'queued', stage = NULL, attempt = attempt + 1,
                          total_chunks = NULL, completed_chunks = NULL, failure = NULL,
                          cancel_requested = 0, updated_at = ?
                   WHERE id = ?""",
                (now_iso(), job_id),
            )
        job = self.get(job_id)
        assert job is not None
        return job

    def recover_interrupted(self) -> list[str]:
        """Jobs left `running` by a previous worker process fail with WORKER_RESTARTED."""
        with self.db.tx() as conn:
            rows = conn.execute("SELECT id, stage, attempt FROM jobs WHERE status = 'running'")
            interrupted = rows.fetchall()
            for row in interrupted:
                failure = Failure(
                    row["stage"],
                    FailureCode.WORKER_RESTARTED.value,
                    "The worker stopped while this job was running.",
                    True,
                    "Retry to process the audio again from the start.",
                )
                conn.execute(
                    """UPDATE jobs SET status = 'failed', failure = ?, cancel_requested = 0,
                              updated_at = ? WHERE id = ?""",
                    (json.dumps(asdict(failure)), now_iso(), row["id"]),
                )
                conn.execute(
                    """UPDATE chunks SET status = 'failed', updated_at = ?
                       WHERE job_id = ? AND attempt = ? AND status = 'pending'""",
                    (now_iso(), row["id"], row["attempt"]),
                )
        ids = [row["id"] for row in interrupted]
        for job_id in ids:
            log.warning("job %s interrupted by a worker restart; marked WORKER_RESTARTED", job_id)
        return ids

    # --- used by the pipeline -----------------------------------------------------------

    def cancel_requested(self, job_id: str) -> bool:
        with self.db.tx() as conn:
            row = conn.execute("SELECT cancel_requested FROM jobs WHERE id = ?", (job_id,))
            found = row.fetchone()
        return bool(found and found["cancel_requested"])

    def update(self, job_id: str, **fields: Any) -> None:
        assignments = ", ".join(f"{name} = ?" for name in fields)
        with self.db.tx() as conn:
            conn.execute(
                f"UPDATE jobs SET {assignments}, updated_at = ? WHERE id = ?",
                (*fields.values(), now_iso(), job_id),
            )


_JOB_SELECT = """
    SELECT j.*, e.title AS episode_title, e.duration_ms AS duration_ms,
           (SELECT json_array_length(t.body, '$.segments') FROM transcripts t
             WHERE t.episode_id = j.episode_id) AS line_count
    FROM jobs j JOIN episodes e ON e.id = j.episode_id
"""


def _to_contract(row: sqlite3.Row) -> Job:
    total = row["total_chunks"]
    payload = {
        "schemaVersion": CURRENT_SCHEMA_VERSION,
        "id": row["id"],
        "episodeId": row["episode_id"],
        "episodeTitle": row["episode_title"],
        "status": row["status"],
        "stage": row["stage"],
        "attempt": row["attempt"],
        "progress": {"completedChunks": row["completed_chunks"] or 0, "totalChunks": total}
        if total
        else None,
        "failure": json.loads(row["failure"]) if row["failure"] else None,
        "provider": {"id": row["provider_id"], "kind": row["provider_kind"]},
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }
    # 1.7, additive: only real values (a 0 or missing duration is unknown, not "0:00").
    if row["duration_ms"]:
        payload["durationMs"] = row["duration_ms"]
    if row["status"] == "completed" and row["line_count"] is not None:
        payload["lineCount"] = row["line_count"]
    return require_valid(parse_job(payload))


class Pipeline:
    """Runs one attempt of one job, recording every transition."""

    def __init__(self, settings: Settings, storage: Storage, service: JobService) -> None:
        self.settings = settings
        self.storage = storage
        self.service = service
        self.db = service.db

    def run(self, job_id: str) -> None:
        with self.db.tx() as conn:
            row = conn.execute(
                """SELECT j.status, j.attempt, e.id AS episode_id, e.source_path, e.language
                   FROM jobs j JOIN episodes e ON e.id = j.episode_id WHERE j.id = ?""",
                (job_id,),
            ).fetchone()
        if row is None or row["status"] != "queued":
            return  # cancelled while queued, deleted, or already handled

        attempt = row["attempt"]
        episode_id = row["episode_id"]
        stage: JobStage | None = None

        def cancelled() -> bool:
            return self.service.cancel_requested(job_id)

        def enter(next_stage: JobStage, **fields: Any) -> None:
            nonlocal stage
            if cancelled():
                raise Cancelled()
            stage = next_stage
            self.service.update(job_id, stage=next_stage, **fields)
            log.info("job %s attempt %d: %s", job_id, attempt, next_stage)

        # Claim atomically: a cancel that lands first wins, and the job is never run twice.
        with self.db.tx() as conn:
            claimed = conn.execute(
                """UPDATE jobs SET status = 'running', stage = NULL, failure = NULL,
                          updated_at = ? WHERE id = ? AND status = 'queued'""",
                (now_iso(), job_id),
            ).rowcount
        if not claimed:
            return
        try:
            enter("probing")
            source = self.storage.resolve_relative(row["source_path"])
            probe(
                source,
                ffprobe=self.settings.ffprobe_path,
                max_seconds=self.settings.max_audio_seconds,
                cancel=cancelled,
            )

            enter("normalizing")
            work = self.storage.reset_work_dir(episode_id)  # never reuse a previous attempt
            normalized = work / "normalized.wav"
            duration_ms = normalize(
                source, normalized, ffmpeg=self.settings.ffmpeg_path, cancel=cancelled
            )
            with self.db.tx() as conn:
                conn.execute(
                    "UPDATE episodes SET duration_ms = ? WHERE id = ?", (duration_ms, episode_id)
                )

            enter("chunking")
            silences = detect_silences(
                normalized,
                duration_ms,
                self.settings.chunking,
                ffmpeg=self.settings.ffmpeg_path,
                cancel=cancelled,
            )
            plans = plan_chunks(duration_ms, silences, self.settings.chunking)
            check_chunk_spans([(p.index, p.start_ms, p.end_ms) for p in plans], duration_ms)
            paths = write_chunks(normalized, plans, work / "chunks", cancel=cancelled)
            chunks = [
                AudioChunk(p.index, p.start_ms, p.end_ms, path)
                for p, path in zip(plans, paths, strict=True)
            ]
            stamp = now_iso()
            with self.db.tx() as conn:
                conn.executemany(
                    """INSERT INTO chunks (job_id, attempt, idx, start_ms, end_ms, cut, path,
                                           status, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)""",
                    [
                        (
                            job_id,
                            attempt,
                            p.index,
                            p.start_ms,
                            p.end_ms,
                            p.cut,
                            self.storage.relative(path),
                            stamp,
                        )
                        for p, path in zip(plans, paths, strict=True)
                    ],
                )

            enter("transcribing", total_chunks=len(chunks), completed_chunks=0)
            for chunk in chunks:
                if cancelled():
                    raise Cancelled()
                segments = self.service.provider.transcribe(chunk, cancelled)
                with self.db.tx() as conn:
                    conn.execute(
                        """UPDATE chunks SET status = 'done', segments = ?, updated_at = ?
                           WHERE job_id = ? AND attempt = ? AND idx = ?""",
                        (
                            json.dumps([asdict(s) for s in segments], ensure_ascii=False),
                            now_iso(),
                            job_id,
                            attempt,
                            chunk.index,
                        ),
                    )
                    conn.execute(
                        """UPDATE jobs SET completed_chunks = ?, updated_at = ?
                           WHERE id = ?""",
                        (chunk.index + 1, now_iso(), job_id),
                    )

            enter("merging")
            transcript, report = merge_with_report(
                episode_id=episode_id,
                duration_ms=duration_ms,
                language=row["language"],
                chunks=self._completed_chunks(
                    job_id, attempt, expected=len(chunks), duration_ms=duration_ms
                ),
                provider=self.service.provider,
                review=self.settings.review,
            )
            log.info("job %s attempt %d: merge %s", job_id, attempt, report)
            if not transcript.segments:
                raise PipelineError(
                    FailureCode.NO_SPEECH_DETECTED,
                    "Pebble didn't find any speech in this audio, so there is no transcript.",
                    hint="Check that the file contains spoken Mandarin. Silence, music or very "
                    "quiet recordings can produce no transcript.",
                )
            with self.db.tx() as conn:
                conn.execute(
                    """INSERT OR REPLACE INTO transcripts (episode_id, job_id, attempt, body,
                                                          created_at)
                       VALUES (?, ?, ?, ?, ?)""",
                    (
                        episode_id,
                        job_id,
                        attempt,
                        json.dumps(transcript.dump(), ensure_ascii=False),
                        now_iso(),
                    ),
                )
                conn.execute(
                    """UPDATE jobs SET status = 'completed', cancel_requested = 0,
                              updated_at = ? WHERE id = ?""",
                    (now_iso(), job_id),
                )
            log.info(
                "job %s attempt %d: completed (%d segments)",
                job_id,
                attempt,
                len(transcript.segments),
            )
        except Cancelled:
            self._end(
                job_id,
                attempt,
                "cancelled",
                "cancelled",
                Failure(
                    stage,
                    FailureCode.CANCELLED.value,
                    "Cancelled.",
                    True,
                    "Retry to process this audio again from the start.",
                ),
            )
        except PipelineError as error:
            self._end(job_id, attempt, "failed", "failed", Failure.from_error(stage, error))
        except Exception:
            log.exception("job %s attempt %d: unexpected error", job_id, attempt)
            self._end(
                job_id,
                attempt,
                "failed",
                "failed",
                Failure(
                    stage,
                    FailureCode.INTERNAL_ERROR.value,
                    "Something unexpected went wrong.",
                    True,
                    "Retry. If it keeps failing, check ~/.pebble/logs/worker.log.",
                ),
            )

    def _completed_chunks(
        self, job_id: str, attempt: int, expected: int, duration_ms: int
    ) -> list[ChunkResult]:
        """
        Only a complete set of done chunks from *this* attempt may be merged, and the stored
        chunks must still tile the audio exactly (check_chunk_spans).
        """
        with self.db.tx() as conn:
            rows = conn.execute(
                """SELECT idx, start_ms, end_ms, status, segments FROM chunks
                   WHERE job_id = ? AND attempt = ? ORDER BY idx""",
                (job_id, attempt),
            ).fetchall()
        if len(rows) != expected or any(
            r["status"] != "done" or r["segments"] is None for r in rows
        ):
            raise PipelineError(
                FailureCode.INTERNAL_ERROR, "Not every chunk finished; nothing was merged."
            )
        check_chunk_spans([(r["idx"], r["start_ms"], r["end_ms"]) for r in rows], duration_ms)
        return [
            ChunkResult(
                r["start_ms"],
                [_raw_segment(s) for s in json.loads(r["segments"])],
                index=r["idx"],
                end_ms=r["end_ms"],
            )
            for r in rows
        ]

    def _end(
        self, job_id: str, attempt: int, status: str, chunk_status: str, failure: Failure
    ) -> None:
        with self.db.tx() as conn:
            conn.execute(
                """UPDATE jobs SET status = ?, failure = ?, cancel_requested = 0, updated_at = ?
                   WHERE id = ?""",
                (status, json.dumps(asdict(failure)), now_iso(), job_id),
            )
            conn.execute(
                """UPDATE chunks SET status = ?, updated_at = ?
                   WHERE job_id = ? AND attempt = ? AND status = 'pending'""",
                (chunk_status, now_iso(), job_id, attempt),
            )
        log.info("job %s attempt %d: %s (%s)", job_id, attempt, status, failure.code)


class JobRunner:
    """
    One background thread doing one thing at a time: transcription jobs in submission order and,
    when no transcription job is waiting, queued speaker runs (ADR 0009), oldest first. A running
    speaker run is never interrupted by a new job; the job simply goes next. On stop, waiting
    jobs are still drained as before, but no new speaker run starts (they stay queued and resume
    at the next start).
    """

    def __init__(self, pipeline: Pipeline, speakers: SpeakerWork | None = None) -> None:
        self.pipeline = pipeline
        self.speakers = speakers
        self._jobs: deque[str] = deque()
        self._speaker_runs: deque[str] = deque()
        self._wake = threading.Condition()
        self._stopping = False
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self.pipeline.service.recover_interrupted()
        queued_runs = self.speakers.recover() if self.speakers else []
        with self._wake:
            self._jobs.extend(self.pipeline.service.queued_ids())
            self._speaker_runs.extend(queued_runs)
            self._stopping = False
        self._thread = threading.Thread(target=self._loop, name="pebble-jobs", daemon=True)
        self._thread.start()

    def submit(self, job_id: str) -> None:
        with self._wake:
            self._jobs.append(job_id)
            self._wake.notify()

    def submit_speakers(self, run_id: str) -> None:
        with self._wake:
            self._speaker_runs.append(run_id)
            self._wake.notify()

    def stop(self, timeout: float = 10) -> None:
        if self._thread is None:
            return
        with self._wake:
            self._stopping = True
            self._wake.notify()
        self._thread.join(timeout)
        self._thread = None

    def _next(self) -> tuple[str, str] | None:
        with self._wake:
            while not self._jobs and not (self._speaker_runs and not self._stopping):
                if self._stopping:
                    return None
                self._wake.wait()
            if self._jobs:  # transcription first, always
                return "job", self._jobs.popleft()
            return "speakers", self._speaker_runs.popleft()

    def _loop(self) -> None:
        while (item := self._next()) is not None:
            kind, work_id = item
            try:
                if kind == "job":
                    self.pipeline.run(work_id)
                elif self.speakers is not None:
                    self.speakers.run(work_id)
            except Exception:  # the runner must survive anything a single item does
                log.exception("runner: %s %s crashed", kind, work_id)


def _raw_segment(stored: dict[str, Any]) -> RawSegment:
    """Rebuilds a chunk's stored segment (JSON turns the flag tuple into a list)."""
    return RawSegment(**{**stored, "review_flags": tuple(stored.get("review_flags", ()))})
