"""
The worker's speaker side (ADR 0009): startup recovery, cheap availability, and running one
queued run. Scheduling lives in `jobs.JobRunner`, which runs speaker work only when no
transcription job is waiting; nothing here starts a run automatically after transcription.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from ..config import Settings
from ..contract import SpeakerHealth
from ..db import Database
from ..storage import Storage
from . import isolation, runner
from .campplus import PULL_HINT, CampplusEmbedder
from .store import SpeakerStore

log = logging.getLogger("pebble.speakers")

Execute = Callable[[Database, Storage, Settings, str], str]

ISOLATION_HINT = (
    "Speaker detection needs macOS's built-in sandbox (/usr/bin/sandbox-exec), which isn't "
    "available here. Transcription and English are unaffected."
)


class SpeakerWork:
    def __init__(
        self,
        db: Database,
        storage: Storage,
        settings: Settings,
        *,
        execute: Execute | None = None,
        model_state: Callable[[], str] | None = None,
        isolation_available: Callable[[], bool] = isolation.available,
    ) -> None:
        self.db = db
        self.storage = storage
        self.settings = settings
        self.store = SpeakerStore(db)
        self._execute = execute or (
            lambda db_, storage_, settings_, run_id: runner.execute_run(
                db_, storage_, settings_, run_id
            )
        )
        self._model_state = model_state or CampplusEmbedder(storage).state
        self._isolation_available = isolation_available

    def recover(self) -> list[str]:
        """
        At worker start: runs left running are failed (WORKER_RESTARTED, never re-run silently),
        speaker-owned stale scratch folders are removed, and queued runs are returned to resume,
        oldest first.
        """
        interrupted = self.store.recover_interrupted()
        removed = runner.remove_stale_scratch(self.storage)
        queued = self.store.queued_runs()
        if interrupted or removed or queued:
            log.info(
                "speakers: %d interrupted, %d stale scratch removed, %d queued to resume",
                len(interrupted),
                removed,
                len(queued),
            )
        return queued

    def run(self, run_id: str) -> str:
        status = self._execute(self.db, self.storage, self.settings, run_id)
        log.info("speaker run %s: %s", run_id, status)  # ids and status only
        return status

    def health(self) -> SpeakerHealth:
        """Cheap (file presence and sizes; no hashing, no model load, no process started)."""
        if not self._isolation_available():
            return SpeakerHealth(state="isolation_unavailable", hint=ISOLATION_HINT)
        state = self._model_state()
        if state == "missing":
            return SpeakerHealth(state="model_missing", hint=PULL_HINT)
        if state != "ready":
            return SpeakerHealth(
                state="model_incomplete",
                hint="The speaker model is incomplete. " + PULL_HINT,
            )
        return SpeakerHealth(state="ready", hint=None)

    def payload(self, episode_id: str) -> dict[str, Any]:
        return self.store.episode_speakers(episode_id)
