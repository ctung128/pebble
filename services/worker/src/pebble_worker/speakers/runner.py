"""
The parent side of a speaker run (ADR 0009): prepares a run-local scratch folder, starts the child
with a minimal environment, enforces a finite deadline and cancellation with bounded termination,
validates the child's result, and persists it. Not wired into the worker's queue yet.

The parent never imports model code and never reads exception text from the child: stdout and
stderr go to /dev/null, and only the result file's fixed codes and numbers are used.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import Settings
from ..db import Database
from ..errors import Cancelled
from ..pipeline.normalize import normalize
from ..pipeline.tools import CancelCheck, never_cancelled
from ..storage import PRIVATE_DIR, Storage, make_private
from . import isolation
from .core import (
    SAMPLE_RATE,
    DiarizationResult,
    LineSpan,
    Speaker,
    SpeakerRunError,
    temporary_normalized,
)
from .store import FAILURES, SpeakerStore

#: Child deadline: 10 minutes plus 15 minutes per hour of audio (comfortably above the processing
#: time seen in the evaluation on an Apple M3 Pro), capped at 70 minutes: the value for Pebble's
#: 4-hour audio limit, so a longer limit later can't silently extend it.
BASE_DEADLINE_SECONDS = 600
DEADLINE_SECONDS_PER_AUDIO_HOUR = 900
MAX_DEADLINE_SECONDS = 4200
#: After the deadline (or a cancel), how long the child gets after SIGTERM before SIGKILL.
TERMINATE_GRACE_SECONDS = 10
POLL_SECONDS = 0.2
#: The only inherited variables; everything else (keys, tokens, proxies, credentials) is dropped.
INHERITED = ("LANG", "LC_ALL", "LC_CTYPE", "TZ")
_SPEAKER_ID = re.compile(r"^S[1-9][0-9]{0,3}$")


def deadline_seconds(duration_ms: int) -> float:
    hours = max(0, duration_ms) / 3_600_000
    return min(
        MAX_DEADLINE_SECONDS, BASE_DEADLINE_SECONDS + DEADLINE_SECONDS_PER_AUDIO_HOUR * hours
    )


def child_environment(storage: Storage, scratch: Path) -> dict[str, str]:
    env = {name: os.environ[name] for name in INHERITED if name in os.environ}
    env.update(
        {
            "PATH": "/usr/bin:/bin",
            "HOME": str(scratch / "home"),
            "TMPDIR": str(scratch / "tmp"),
            "NUMBA_CACHE_DIR": str(scratch / "numba"),
            "MODELSCOPE_HOME": str(scratch / "modelscope"),
            "MODELSCOPE_CACHE": str(scratch / "modelscope"),
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONNOUSERSITE": "1",
            "PEBBLE_DATA_DIR": str(storage.root),
        }
    )
    return env


@dataclass(frozen=True)
class Outcome:
    code: str | None  # a FAILURES code, or None when completed
    result: DiarizationResult | None


def run_child(
    storage: Storage,
    *,
    audio: Path,
    lines: Sequence[LineSpan],
    timeout_seconds: float,
    cancel: CancelCheck = never_cancelled,
    command: Sequence[str] | None = None,
    grace_seconds: float = TERMINATE_GRACE_SECONDS,
    speaker_count: int | None = None,
) -> Outcome:
    """Runs one child to completion, deadline or cancellation. Never raises for child failures."""
    storage.ensure()
    scratch = Path(tempfile.mkdtemp(prefix="speakers-", dir=storage.tmp_dir))
    make_private(scratch)
    process: subprocess.Popen[bytes] | None = None
    try:
        for name in ("home", "tmp", "numba", "modelscope"):
            (scratch / name).mkdir(mode=PRIVATE_DIR)
        result_path = scratch / "result.json"
        spec_path = scratch / "spec.json"
        spec = {
            "audio": str(audio),
            "lines": [
                {"id": span.segment_id, "startMs": span.start_ms, "endMs": span.end_ms}
                for span in lines
            ],
            "deadlineAt": time.time() + timeout_seconds,
            "result": str(result_path),
            "numbaCache": str(scratch / "numba"),
            "speakerCount": speaker_count,
        }
        spec_path.write_text(json.dumps(spec), encoding="utf-8")
        make_private(spec_path)
        inner = list(command or [sys.executable, "-m", "pebble_worker.speakers.child"])
        try:
            # The OS sandbox is the boundary; without it the child is never started.
            argv = isolation.isolated_command([*inner, str(spec_path)])
        except isolation.IsolationUnavailable:
            return Outcome("NETWORK_ISOLATION_FAILED", None)
        process = subprocess.Popen(
            argv,
            env=child_environment(storage, scratch),
            cwd=scratch,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,  # its own process group, so stopping it stops everything
        )
        hard_limit = time.monotonic() + timeout_seconds + grace_seconds
        stopped: str | None = None
        while process.poll() is None:
            if cancel():
                stopped = "CANCELLED"
            elif time.monotonic() >= hard_limit:
                stopped = "TIMED_OUT"
            if stopped:
                _terminate(process, grace_seconds)
                return Outcome(stopped, None)
            time.sleep(POLL_SECONDS)
        return _read_result(result_path, lines)
    finally:
        if process is not None and process.poll() is None:
            _terminate(process, grace_seconds)  # an exception or interrupt in this process
        shutil.rmtree(scratch, ignore_errors=True)


def _terminate(process: subprocess.Popen[bytes], grace_seconds: float) -> None:
    """SIGTERM to the child's process group, then SIGKILL after the grace period; bounded."""
    for sig, wait in ((signal.SIGTERM, grace_seconds), (signal.SIGKILL, 5.0)):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            break
        try:
            process.wait(timeout=wait)
            return
        except subprocess.TimeoutExpired:
            continue


def _read_result(path: Path, lines: Sequence[LineSpan]) -> Outcome:
    if not path.is_file():
        return Outcome("CHILD_FAILED", None)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return Outcome("RESULT_INVALID", None)
    if not isinstance(payload, dict):
        return Outcome("RESULT_INVALID", None)
    if "error" in payload:
        code = payload["error"]
        known = isinstance(code, str) and code in FAILURES
        return Outcome(code if known else "RESULT_INVALID", None)
    result = _validated(payload.get("result"), lines)
    return Outcome(None, result) if result else Outcome("RESULT_INVALID", None)


def _validated(raw: Any, lines: Sequence[LineSpan]) -> DiarizationResult | None:
    """The child's result only if it covers exactly the requested lines, in order, consistently."""
    try:
        assignments = raw["assignments"]
        speakers = [
            Speaker(str(s["id"]), int(s["lines"]), int(s["windows"])) for s in raw["speakers"]
        ]
        counts = [int(raw[k]) for k in ("windows", "noiseWindows", "unassignedLines")]
        clustering = str(raw["clustering"])
    except (KeyError, TypeError, ValueError):
        return None
    ids = [s.id for s in speakers]
    if (
        not isinstance(assignments, dict)
        or list(assignments) != [line.segment_id for line in lines]
        or ids != [f"S{n}" for n in range(1, len(ids) + 1)]
        or not all(_SPEAKER_ID.match(i) for i in ids)
        or any(v is not None and v not in ids for v in assignments.values())
        or any(n < 0 for n in counts)
        or any(s.lines < 0 or s.windows < 0 for s in speakers)
        or not 1 <= len(clustering) <= 40
    ):
        return None
    unassigned = sum(1 for v in assignments.values() if v is None)
    if counts[2] != unassigned or any(
        s.lines != sum(1 for v in assignments.values() if v == s.id) for s in speakers
    ):
        return None
    return DiarizationResult(
        assignments=dict(assignments),
        speakers=tuple(speakers),
        windows=counts[0],
        noise_windows=counts[1],
        unassigned_lines=counts[2],
        clustering=clustering,
    )


def execute_run(
    db: Database,
    storage: Storage,
    settings: Settings,
    run_id: str,
    *,
    cancel: CancelCheck = never_cancelled,
    command: Sequence[str] | None = None,
    timeout_seconds: float | None = None,
    grace_seconds: float = TERMINATE_GRACE_SECONDS,
    normalizer: Callable[[Path, Path], int] | None = None,
) -> str:
    """
    One queued run, start to finish: 'completed', 'failed', 'cancelled', or 'gone' (the run or
    its episode disappeared). Transcription, translation and earlier runs are never touched.
    """
    store = SpeakerStore(db)
    if not store.start(run_id):
        return "gone"

    def stopped() -> bool:
        """The caller cancelled, or the run was cancelled or deleted in the database."""
        return cancel() or not store.is_running(run_id)

    found = store.lines_for(run_id)
    if found is None:  # the transcript changed, or the episode was deleted meanwhile
        return "failed" if store.fail(run_id, "TRANSCRIPT_CHANGED") else _settled(db, run_id)
    episode_id, lines, speaker_count = found
    with db.tx() as conn:
        row = conn.execute(
            "SELECT source_path, duration_ms FROM episodes WHERE id = ?", (episode_id,)
        ).fetchone()
    if row is None:
        return "gone"
    duration_ms = int(row["duration_ms"] or 0)
    timeout = deadline_seconds(duration_ms) if timeout_seconds is None else timeout_seconds
    normalized = storage.work_dir(episode_id) / "normalized.wav"

    def launch(audio: Path) -> Outcome:
        return run_child(
            storage,
            audio=audio,
            lines=lines,
            timeout_seconds=timeout,
            cancel=stopped,
            command=command,
            grace_seconds=grace_seconds,
            speaker_count=speaker_count,
        )

    try:
        if _usable(normalized, duration_ms):
            outcome = launch(normalized)
        else:
            source = storage.resolve_relative(row["source_path"])
            convert = normalizer or (
                lambda src, dst: normalize(src, dst, ffmpeg=settings.ffmpeg_path, cancel=stopped)
            )
            with temporary_normalized(source, storage.tmp_dir, convert) as audio:
                outcome = launch(audio)
    except Cancelled:
        outcome = Outcome("CANCELLED", None)
    except SpeakerRunError as error:
        outcome = Outcome(error.code, None)
    except Exception:
        outcome = Outcome("CHILD_FAILED", None)
    if outcome.result is None:
        code = outcome.code or "CHILD_FAILED"
        if store.fail(run_id, code):  # type: ignore[arg-type]
            return "cancelled" if code == "CANCELLED" else "failed"
        return _settled(db, run_id)  # cancelled or deleted while it ran
    status = store.complete(run_id, outcome.result)
    if status == "discarded":
        return _settled(db, run_id)
    return "completed" if status == "completed" else "failed"


def _settled(db: Database, run_id: str) -> str:
    """What became of a run that was stopped from outside: 'cancelled', or 'gone' if deleted."""
    with db.tx() as conn:
        row = conn.execute("SELECT status FROM speaker_runs WHERE id = ?", (run_id,)).fetchone()
    return "gone" if row is None else str(row["status"])


#: Folder names run_child creates (tempfile.mkdtemp with this prefix).
_SCRATCH_NAME = re.compile(r"^speakers-[A-Za-z0-9_]{8}$")


def remove_stale_scratch(storage: Storage) -> int:
    """
    At worker start: scratch folders left by a run the previous process never finished. Only
    folders that are verifiably speaker-owned are removed: a real directory (not a symlink)
    directly inside `<data>/tmp`, named exactly as run_child names them, owned by this user.
    """
    removed = 0
    if not storage.tmp_dir.is_dir() or storage.tmp_dir.is_symlink():
        return 0
    root = storage.tmp_dir.resolve()
    for path in storage.tmp_dir.iterdir():
        if not _SCRATCH_NAME.match(path.name) or path.is_symlink() or not path.is_dir():
            continue
        if path.resolve().parent != root or path.stat().st_uid != os.getuid():
            continue
        shutil.rmtree(path, ignore_errors=True)
        removed += 1
    return removed


def _usable(path: Path, duration_ms: int) -> bool:
    import wave

    try:
        with wave.open(str(path), "rb") as wav:
            shape = (wav.getframerate(), wav.getnchannels(), wav.getsampwidth())
            frames = wav.getnframes()
    except (OSError, EOFError, wave.Error):
        return False
    return shape == (SAMPLE_RATE, 1, 2) and abs(frames * 1000 / SAMPLE_RATE - duration_ms) <= 500
