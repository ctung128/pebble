"""
Speaker runs, their original assignments and learner corrections, in the worker database
(migration 3; ADR 0009 amendment).

- A run is tied to its episode and to the transcript version it labelled. A newer transcript makes
  the run stale (it is no longer `current`) instead of re-pointing its segment ids.
- `current` is the latest **completed** run for the current transcript, so a queued, running,
  failed or cancelled re-detection never hides it. `latest` is the most recent run of any status.
- Original assignments are never edited. Corrections are stored per completed run and are only
  accepted for the episode's current run, so an old run's corrections never apply to a new one.
- Only ids, times, counts, fixed failure codes and learner-typed names are stored.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from ..contract import (
    CURRENT_SCHEMA_VERSION,
    SpeakerCorrectionSet,
    SpeakerCorrectionsRequest,
    SpeakerFailureCode,
    parse_episode_speakers,
    require_valid,
    speaker_correction_issues,
)
from ..db import Database, now_iso
from ..models.manifest import CAMPPLUS_SV_ZH, ModelSpec
from .core import DiarizationResult, LineSpan

#: Fixed copy for each failure code: (message, retryable). Never exception text.
FAILURES: dict[str, tuple[str, bool]] = {
    "SPEAKER_MODEL_UNAVAILABLE": (
        "The speaker model isn't installed or didn't verify. "
        "Download it with: npm run worker:models -- pull --speaker",
        True,
    ),
    "AUDIO_UNAVAILABLE": ("This episode's audio couldn't be read for speaker detection.", True),
    "INVALID_INPUT": ("This episode's lines couldn't be used for speaker detection.", False),
    "EMBEDDING_FAILED": ("Speaker detection failed while analysing the audio.", True),
    "CLUSTERING_FAILED": ("Speaker detection couldn't group the voices.", True),
    "NETWORK_ISOLATION_FAILED": (
        "Speaker detection didn't start because network access couldn't be blocked.",
        True,
    ),
    "TIMED_OUT": ("Speaker detection took too long and was stopped.", True),
    "CANCELLED": ("Speaker detection was cancelled.", True),
    "WORKER_RESTARTED": ("Pebble stopped while speakers were being detected.", True),
    "CHILD_FAILED": ("Speaker detection stopped unexpectedly.", True),
    "RESULT_INVALID": ("Speaker detection returned an unusable result.", True),
    "TRANSCRIPT_CHANGED": (
        "The transcript changed while speakers were being detected, so that result wasn't used.",
        True,
    ),
}

CorrectionErrorCode = Literal[
    "EPISODE_NOT_FOUND",
    "RUN_MISMATCH",
    "RUN_NOT_COMPLETED",
    "INVALID_CORRECTIONS",
    "REVISION_CONFLICT",
]


CompleteStatus = Literal["completed", "stale", "discarded"]


class SpeakerConflict(Exception):
    """The episode already has a queued or running speaker run."""


class SpeakerNotAvailable(Exception):
    """No such episode, or it has no transcript to label."""


@dataclass
class CorrectionError(Exception):
    code: CorrectionErrorCode
    message: str
    issues: list[tuple[str, str]]


def new_run_id() -> str:
    return f"spk-{uuid.uuid4().hex[:12]}"


class SpeakerStore:
    def __init__(self, db: Database, *, spec: ModelSpec = CAMPPLUS_SV_ZH) -> None:
        self.db = db
        self.spec = spec

    # --- runs ---------------------------------------------------------------------------------

    def create_run(self, episode_id: str, speaker_hint: int | None = None) -> str:
        """
        A new queued run, claimed atomically: the partial unique index allows one queued or
        running run per episode, so two concurrent requests can't both succeed.
        """
        run_id = new_run_id()
        stamp = now_iso()
        with self.db.tx() as conn:
            row = conn.execute(
                "SELECT created_at FROM transcripts WHERE episode_id = ?", (episode_id,)
            ).fetchone()
            if row is None:
                raise SpeakerNotAvailable(episode_id)
            try:
                conn.execute(
                    """INSERT INTO speaker_runs (id, episode_id, status, model_id, model_revision,
                         transcript_created_at, speaker_hint, created_at, updated_at)
                       VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)""",
                    (
                        run_id,
                        episode_id,
                        self.spec.model_id,
                        self.spec.revision,
                        row["created_at"],
                        speaker_hint,
                        stamp,
                        stamp,
                    ),
                )
            except sqlite3.IntegrityError as error:
                gone = conn.execute("SELECT 1 FROM episodes WHERE id = ?", (episode_id,)).fetchone()
                if gone is None:  # deleted between the read and the insert
                    raise SpeakerNotAvailable(episode_id) from error
                raise SpeakerConflict(episode_id) from error
        return run_id

    def start(self, run_id: str) -> bool:
        """queued → running; False if the run is gone (episode deleted) or not queued."""
        with self.db.tx() as conn:
            changed = conn.execute(
                """UPDATE speaker_runs SET status = 'running', updated_at = ?
                   WHERE id = ? AND status = 'queued'""",
                (now_iso(), run_id),
            ).rowcount
        return bool(changed)

    def lines_for(self, run_id: str) -> tuple[str, list[LineSpan], int | None] | None:
        """
        The run's episode, its transcript's lines as ids and times, and its speaker-count hint;
        None if the transcript changed or the run is gone.
        """
        with self.db.tx() as conn:
            row = conn.execute(
                """SELECT r.episode_id, r.speaker_hint, t.body FROM speaker_runs r
                   JOIN transcripts t ON t.episode_id = r.episode_id
                   WHERE r.id = ? AND t.created_at = r.transcript_created_at""",
                (run_id,),
            ).fetchone()
        if row is None:
            return None
        segments = json.loads(row["body"])["segments"]
        spans = [LineSpan(s["id"], int(s["startMs"]), int(s["endMs"])) for s in segments]
        return row["episode_id"], spans, row["speaker_hint"]

    def complete(self, run_id: str, result: DiarizationResult) -> CompleteStatus:
        """
        running → completed with its labels and original assignments, atomically. A run whose
        transcript was replaced meanwhile is failed (TRANSCRIPT_CHANGED) and never published;
        a run that was deleted or already stopped (cancelled) is discarded.
        """
        stamp = now_iso()
        with self.db.tx() as conn:
            row = conn.execute(
                """SELECT r.status, r.transcript_created_at = t.created_at AS same_transcript
                   FROM speaker_runs r LEFT JOIN transcripts t ON t.episode_id = r.episode_id
                   WHERE r.id = ?""",
                (run_id,),
            ).fetchone()
            if row is None or row["status"] != "running":
                return "discarded"  # deleted with its episode, or cancelled meanwhile
            if not row["same_transcript"]:
                conn.execute(
                    """UPDATE speaker_runs SET status = 'failed',
                         failure_code = 'TRANSCRIPT_CHANGED', updated_at = ? WHERE id = ?""",
                    (stamp, run_id),
                )
                return "stale"
            conn.executemany(
                """INSERT INTO speaker_labels (run_id, speaker_id, position, lines, windows)
                   VALUES (?, ?, ?, ?, ?)""",
                [
                    (run_id, s.id, position, s.lines, s.windows)
                    for position, s in enumerate(result.speakers, start=1)
                ],
            )
            conn.executemany(
                "INSERT INTO speaker_assignments (run_id, segment_id, speaker_id) VALUES (?, ?, ?)",
                [(run_id, segment, speaker) for segment, speaker in result.assignments.items()],
            )
            conn.execute(
                """UPDATE speaker_runs SET status = 'completed', clustering = ?, windows = ?,
                     noise_windows = ?, unassigned_lines = ?, updated_at = ?, completed_at = ?
                   WHERE id = ?""",
                (
                    result.clustering,
                    result.windows,
                    result.noise_windows,
                    result.unassigned_lines,
                    stamp,
                    stamp,
                    run_id,
                ),
            )
        return "completed"

    def is_running(self, run_id: str) -> bool:
        """Polled by the parent while the child works: False once cancelled, failed or deleted."""
        with self.db.tx() as conn:
            row = conn.execute("SELECT status FROM speaker_runs WHERE id = ?", (run_id,)).fetchone()
        return row is not None and row["status"] == "running"

    def cancel_for_episode(self, episode_id: str) -> list[str]:
        """
        Cancels the episode's queued and running runs (before the episode is deleted). A running
        child notices through `is_running` and is stopped; any late result is discarded.
        """
        with self.db.tx() as conn:
            ids = [
                r["id"]
                for r in conn.execute(
                    """SELECT id FROM speaker_runs WHERE episode_id = ?
                       AND status IN ('queued', 'running')""",
                    (episode_id,),
                )
            ]
        for run_id in ids:
            self.fail(run_id, "CANCELLED")
        return ids

    def cancel_run(self, episode_id: str, run_id: str) -> dict[str, Any]:
        """
        Cancels exactly this run if it is still queued or running; a run that already ended is
        left as it is (idempotent). Never touches any other run, so a late request can't cancel
        a newer one. Returns the episode's speakers.
        """
        with self.db.tx() as conn:
            row = conn.execute(
                "SELECT episode_id FROM speaker_runs WHERE id = ?", (run_id,)
            ).fetchone()
        if row is None or row["episode_id"] != episode_id:
            raise SpeakerNotAvailable(run_id)
        self.fail(run_id, "CANCELLED")  # a no-op unless queued or running
        return self.episode_speakers(episode_id)

    def queued_runs(self) -> list[str]:
        """
        Restart policy for **queued** runs: they never started, so they are resumed, oldest
        first. (Running runs are failed by `recover_interrupted`, never re-run silently.)
        """
        with self.db.tx() as conn:
            return [
                r["id"]
                for r in conn.execute(
                    "SELECT id FROM speaker_runs WHERE status = 'queued' ORDER BY created_at, rowid"
                )
            ]

    def fail(self, run_id: str, code: SpeakerFailureCode) -> bool:
        """queued/running → failed (or cancelled for CANCELLED). False if gone or finished."""
        if code not in FAILURES:
            raise ValueError(code)
        status = "cancelled" if code == "CANCELLED" else "failed"
        with self.db.tx() as conn:
            changed = conn.execute(
                """UPDATE speaker_runs SET status = ?, failure_code = ?, updated_at = ?
                   WHERE id = ? AND status IN ('queued', 'running')""",
                (status, code, now_iso(), run_id),
            ).rowcount
        return bool(changed)

    def recover_interrupted(self) -> list[str]:
        """Runs left running by a previous worker process fail with WORKER_RESTARTED."""
        with self.db.tx() as conn:
            ids = [
                r["id"]
                for r in conn.execute("SELECT id FROM speaker_runs WHERE status = 'running'")
            ]
        for run_id in ids:
            self.fail(run_id, "WORKER_RESTARTED")
        return ids

    # --- reads --------------------------------------------------------------------------------

    def episode_speakers(self, episode_id: str) -> dict[str, Any]:
        """The EpisodeSpeakers payload (validated against the contract)."""
        with self.db.tx() as conn:
            if (
                conn.execute("SELECT 1 FROM episodes WHERE id = ?", (episode_id,)).fetchone()
                is None
            ):
                raise SpeakerNotAvailable(episode_id)
            current = self._current_run(conn, episode_id)
            latest = conn.execute(
                """SELECT * FROM speaker_runs WHERE episode_id = ?
                   ORDER BY created_at DESC, rowid DESC LIMIT 1""",
                (episode_id,),
            ).fetchone()
            payload = {
                "schemaVersion": CURRENT_SCHEMA_VERSION,
                "episodeId": episode_id,
                "current": None if current is None else self._result(conn, current),
                "latest": None if latest is None else _state(latest),
            }
        return require_valid(parse_episode_speakers(payload)).dump()

    @staticmethod
    def _current_run(conn: sqlite3.Connection, episode_id: str) -> sqlite3.Row | None:
        return conn.execute(
            """SELECT r.* FROM speaker_runs r
               JOIN transcripts t ON t.episode_id = r.episode_id
               WHERE r.episode_id = ? AND r.status = 'completed'
                 AND r.transcript_created_at = t.created_at
               ORDER BY r.completed_at DESC, r.rowid DESC LIMIT 1""",
            (episode_id,),
        ).fetchone()

    @staticmethod
    def _result(conn: sqlite3.Connection, run: sqlite3.Row) -> dict[str, Any]:
        labels = conn.execute(
            "SELECT speaker_id, lines, windows FROM speaker_labels WHERE run_id = ? "
            "ORDER BY position",
            (run["id"],),
        ).fetchall()
        assignments = {
            r["segment_id"]: r["speaker_id"]
            for r in conn.execute(
                "SELECT segment_id, speaker_id FROM speaker_assignments WHERE run_id = ? "
                "ORDER BY rowid",
                (run["id"],),
            )
        }
        stored = conn.execute(
            "SELECT body, revision, updated_at FROM speaker_corrections WHERE run_id = ?",
            (run["id"],),
        ).fetchone()
        corrections = (
            None
            if stored is None
            else {
                **json.loads(stored["body"]),
                "revision": stored["revision"],
                "updatedAt": stored["updated_at"],
            }
        )
        return {
            "runId": run["id"],
            "completedAt": run["completed_at"],
            "provenance": {
                "modelId": run["model_id"],
                "modelRevision": run["model_revision"],
                "speakerCountHint": run["speaker_hint"],
                "clustering": run["clustering"],
                "windows": run["windows"],
                "noiseWindows": run["noise_windows"],
                "unassignedLines": run["unassigned_lines"],
            },
            "speakers": [
                {"id": r["speaker_id"], "lines": r["lines"], "windows": r["windows"]}
                for r in labels
            ],
            "assignments": assignments,
            "corrections": corrections,
            "effective": apply_corrections(assignments, corrections),
        }

    # --- corrections --------------------------------------------------------------------------

    def put_corrections(self, request: SpeakerCorrectionsRequest) -> dict[str, Any]:
        """Replaces the corrections of the episode's current run; validated against that run."""
        with self.db.tx() as conn:
            if (
                conn.execute(
                    "SELECT 1 FROM episodes WHERE id = ?", (request.episode_id,)
                ).fetchone()
                is None
            ):
                raise CorrectionError("EPISODE_NOT_FOUND", "No such episode.", [])
            run = conn.execute(
                "SELECT id, episode_id, status FROM speaker_runs WHERE id = ?", (request.run_id,)
            ).fetchone()
            if run is None or run["episode_id"] != request.episode_id:
                raise CorrectionError(
                    "RUN_MISMATCH", "These corrections are for another speaker run.", []
                )
            if run["status"] != "completed":
                raise CorrectionError(
                    "RUN_NOT_COMPLETED", "Only a completed speaker run can be corrected.", []
                )
            current = self._current_run(conn, request.episode_id)
            if current is None or current["id"] != request.run_id:
                raise CorrectionError(
                    "RUN_MISMATCH",
                    "These corrections are for an older speaker run; reload the speakers.",
                    [],
                )
            speakers = {
                r["speaker_id"]
                for r in conn.execute(
                    "SELECT speaker_id FROM speaker_labels WHERE run_id = ?", (request.run_id,)
                )
            }
            segments = {
                r["segment_id"]
                for r in conn.execute(
                    "SELECT segment_id FROM speaker_assignments WHERE run_id = ?", (request.run_id,)
                )
            }
            issues = [(i.path, i.message) for i in speaker_correction_issues(request)]
            issues += _run_issues(request, speakers, segments)
            if issues:
                raise CorrectionError(
                    "INVALID_CORRECTIONS", "The corrections aren't valid.", issues
                )
            body = SpeakerCorrectionSet(
                names=request.names,
                merges=request.merges,
                not_speaker=request.not_speaker,
                lines=request.lines,
            ).dump()
            # Compare-and-set on the revision the edit was based on: a stale edit is refused, never
            # merged over a newer one.
            encoded = json.dumps(body, ensure_ascii=False)
            if request.revision == 0:
                try:
                    conn.execute(
                        """INSERT INTO speaker_corrections (run_id, body, revision, updated_at)
                           VALUES (?, ?, 1, ?)""",
                        (request.run_id, encoded, now_iso()),
                    )
                    changed = 1
                except sqlite3.IntegrityError:
                    changed = 0
            else:
                changed = conn.execute(
                    """UPDATE speaker_corrections SET body = ?, revision = revision + 1,
                         updated_at = ? WHERE run_id = ? AND revision = ?""",
                    (encoded, now_iso(), request.run_id, request.revision),
                ).rowcount
            if not changed:
                raise CorrectionError(
                    "REVISION_CONFLICT",
                    "These speaker corrections changed since you loaded them. Reload and retry.",
                    [],
                )
        return self.episode_speakers(request.episode_id)


def _run_issues(
    c: SpeakerCorrectionSet, speakers: set[str], segments: set[str]
) -> list[tuple[str, str]]:
    issues: list[tuple[str, str]] = []
    for path, ids in (
        ("names", list(c.names)),
        ("merges", [*c.merges, *c.merges.values()]),
        ("notSpeaker", list(c.not_speaker)),
        ("lines", [s for s in c.lines.values() if s is not None]),
    ):
        for speaker in ids:
            if speaker not in speakers:
                issues.append((path, f"{speaker} is not a speaker in this run"))
    for segment in c.lines:
        if segment not in segments:
            issues.append((f"lines.{segment}", "unknown line"))
    return issues


def apply_corrections(
    assignments: Mapping[str, str | None], corrections: Mapping[str, Any] | None
) -> dict[str, str | None]:
    """Line reassignments win; otherwise merges, then not-a-speaker clusters, apply."""
    if not corrections:
        return dict(assignments)
    merges = corrections.get("merges", {})
    not_speaker = set(corrections.get("notSpeaker", []))
    lines = corrections.get("lines", {})
    effective: dict[str, str | None] = {}
    for segment, speaker in assignments.items():
        if segment in lines:
            effective[segment] = lines[segment]
            continue
        speaker = merges.get(speaker, speaker) if speaker is not None else None
        effective[segment] = None if speaker in not_speaker else speaker
    return effective


def _state(row: sqlite3.Row) -> dict[str, Any]:
    failure = None
    if row["failure_code"] is not None:
        message, retryable = FAILURES[row["failure_code"]]
        failure = {"code": row["failure_code"], "message": message, "retryable": retryable}
    return {
        "runId": row["id"],
        "status": row["status"],
        "failure": failure,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }
