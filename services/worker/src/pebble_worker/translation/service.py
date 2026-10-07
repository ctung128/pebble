"""
One line, on an explicit request (ADR 0008, docs/TRANSLATION.md#limits-and-order-of-a-request):

1. validate the episode, segment and text;
2. return an exact cache hit (no consent, key or budget needed);
3. require a configured provider and current consent;
4. join an identical in-flight request, or become its owner (joiners reserve nothing);
5. the owner rechecks the cache, then in one transaction rechecks consent and the episode and
   reserves one request and its characters;
6. only the owner calls the provider, once;
7. a result is stored only if the episode still exists.

Usage counts reservations, not guaranteed deliveries: a reservation is never refunded.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

from ..contract import (
    CURRENT_SCHEMA_VERSION,
    TRANSLATION_CACHE_VERSION,
    TRANSLATION_PROVIDER,
    TRANSLATION_TARGET_LANGUAGE,
    EpisodeTranslations,
    TranslationResult,
    translation_text_problem,
)
from ..db import Database, now_iso
from .config import TranslationSettings
from .deepl import DeepLClient, ProviderFailure
from .store import CONSENT_VERSION, current_period

log = logging.getLogger("pebble.translation")

#: How long a joined request waits for its owner: the provider timeout plus a margin.
JOIN_TIMEOUT_SECONDS = 20.0


class TranslationError(Exception):
    """A refusal or failure with a fixed code and message, safe to return as-is."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(code)
        self.status, self.code, self.message = status, code, message


#: Fixed copy (docs/TRANSLATION.md#errors). Messages never contain text, ids or provider output.
ERRORS: dict[str, tuple[int, str]] = {
    "TRANSLATION_OFF": (409, "English isn't set up for Pebble on this computer."),
    "TRANSLATION_CONSENT_REQUIRED": (409, "Allow translation with DeepL first."),
    "TRANSLATION_LOCAL_LIMIT": (
        429,
        "Pebble's monthly translation limit on this computer has been reached. Saved English "
        "still shows.",
    ),
    "TRANSLATION_RATE_LIMITED": (
        503,
        "DeepL is busy right now. Wait a moment, then tap English again.",
    ),
    "TRANSLATION_PROVIDER_QUOTA": (
        503,
        "Your DeepL account's character allowance has been reached. Check your DeepL account.",
    ),
    "TRANSLATION_KEY_REJECTED": (502, "DeepL didn't accept the key set up for Pebble."),
    "TRANSLATION_REQUEST_REJECTED": (502, "DeepL couldn't translate this line."),
    "TRANSLATION_UNAVAILABLE": (503, "Translation is unavailable right now. Try again later."),
    "TRANSLATION_INVALID_TEXT": (422, "This line can't be translated."),
    "TRANSLATION_NOT_ALLOWED": (409, "Lines from this transcript can't be translated."),
    "EPISODE_NOT_FOUND": (404, "This episode or line no longer exists."),
    "SEGMENT_NOT_FOUND": (404, "This episode or line no longer exists."),
}


def error(code: str) -> TranslationError:
    status, message = ERRORS[code]
    return TranslationError(status, code, message)


def fingerprint(text: str) -> str:
    """SHA-256 of the exact submitted text's UTF-8 bytes (docs/TRANSLATION.md)."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass
class _Flight:
    done: threading.Event = field(default_factory=threading.Event)
    result: TranslationResult | None = None
    failure: TranslationError | None = None


class TranslationService:
    def __init__(
        self,
        db: Database,
        settings: TranslationSettings,
        client_factory: Callable[[TranslationSettings], DeepLClient] | None = None,
        *,
        join_timeout: float = JOIN_TIMEOUT_SECONDS,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.db = db
        self.settings = settings
        self._client_factory = client_factory or (lambda s: DeepLClient(s.auth_key))  # type: ignore[arg-type]
        self._client: DeepLClient | None = None
        self.join_timeout = join_timeout
        self.clock = clock
        self._lock = threading.Lock()
        self._flights: dict[tuple[str, str, str], _Flight] = {}

    # --- Startup -------------------------------------------------------------------------

    def reconcile(self) -> int:
        """Marks reservations left by a previous run as `unknown`. Never contacts DeepL."""
        with self.db.tx() as conn:
            cursor = conn.execute(
                "UPDATE translation_attempts SET status = 'unknown', updated_at = ? "
                "WHERE status = 'reserved'",
                (now_iso(),),
            )
            return cursor.rowcount

    # --- Reading the cache (never contacts DeepL) ------------------------------------------

    def episode_translations(self, episode_id: str) -> EpisodeTranslations:
        with self.db.tx() as conn:
            if (
                conn.execute("SELECT 1 FROM episodes WHERE id = ?", (episode_id,)).fetchone()
                is None
            ):
                raise error("EPISODE_NOT_FOUND")
            rows = conn.execute(
                "SELECT segment_id, source_fingerprint, text, created_at FROM translations "
                "WHERE episode_id = ? AND provider = ? AND target_lang = ? AND cache_version = ? "
                "ORDER BY created_at, rowid",
                (
                    episode_id,
                    TRANSLATION_PROVIDER,
                    TRANSLATION_TARGET_LANGUAGE,
                    TRANSLATION_CACHE_VERSION,
                ),
            ).fetchall()
        return EpisodeTranslations.model_validate(
            {
                "schemaVersion": CURRENT_SCHEMA_VERSION,
                "episodeId": episode_id,
                "provider": TRANSLATION_PROVIDER,
                "targetLanguage": TRANSLATION_TARGET_LANGUAGE,
                "cacheVersion": TRANSLATION_CACHE_VERSION,
                "translations": [
                    {
                        "segmentId": r["segment_id"],
                        "fingerprint": r["source_fingerprint"],
                        "text": r["text"],
                        "createdAt": r["created_at"],
                    }
                    for r in rows
                ],
            }
        )

    # --- One line --------------------------------------------------------------------------

    def translate(self, episode_id: str, segment_id: str, text: str) -> TranslationResult:
        self._check_eligible(episode_id, segment_id)
        if translation_text_problem(text) is not None:
            raise error("TRANSLATION_INVALID_TEXT")
        fp = fingerprint(text)
        cached = self._cached(episode_id, segment_id, fp)
        if cached:
            return cached
        if not self.settings.configured:
            raise error("TRANSLATION_OFF")
        if not self._consent_current():
            raise error("TRANSLATION_CONSENT_REQUIRED")

        key = (episode_id, segment_id, fp)
        with self._lock:
            flight = self._flights.get(key)
            owner = flight is None
            if owner:
                flight = self._flights[key] = _Flight()
        assert flight is not None
        if not owner:
            return self._join(flight)
        try:
            flight.result = self._own(episode_id, segment_id, text, fp)
            return flight.result
        except TranslationError as failure:
            flight.failure = failure
            raise
        except Exception:
            flight.failure = error("TRANSLATION_UNAVAILABLE")
            raise
        finally:
            with self._lock:
                self._flights.pop(key, None)
            flight.done.set()

    def _join(self, flight: _Flight) -> TranslationResult:
        if not flight.done.wait(self.join_timeout):
            raise error("TRANSLATION_UNAVAILABLE")
        if flight.result is not None:
            return flight.result
        raise flight.failure or error("TRANSLATION_UNAVAILABLE")

    def _own(self, episode_id: str, segment_id: str, text: str, fp: str) -> TranslationResult:
        cached = self._cached(episode_id, segment_id, fp)
        if cached:
            return cached
        attempt_id = self._reserve(episode_id, len(text))
        try:
            english = self._provider().translate(text)
        except ProviderFailure as failure:
            self._finish(attempt_id, "failed", failure.code, failure.http_status)
            log.info(
                "translation failed: %s (HTTP %s, %d characters)",
                failure.code,
                failure.http_status,
                len(text),
            )
            raise error(failure.code) from None
        except Exception:
            # A bug, not a provider failure: record the attempt, then let it surface (joined
            # requests still get TRANSLATION_UNAVAILABLE, and the in-flight entry is removed).
            self._finish(attempt_id, "failed", "TRANSLATION_UNAVAILABLE", None)
            log.error("translation failed unexpectedly (%d characters)", len(text))
            raise
        return self._store(attempt_id, episode_id, segment_id, fp, len(text), english)

    # --- Steps ---------------------------------------------------------------------------

    def _check_eligible(self, episode_id: str, segment_id: str) -> None:
        with self.db.tx() as conn:
            row = conn.execute(
                "SELECT j.status, j.provider_kind, t.body FROM episodes e "
                "JOIN jobs j ON j.episode_id = e.id "
                "LEFT JOIN transcripts t ON t.episode_id = e.id WHERE e.id = ?",
                (episode_id,),
            ).fetchone()
        if row is None:
            raise error("EPISODE_NOT_FOUND")
        if row["status"] != "completed" or row["provider_kind"] != "asr" or row["body"] is None:
            raise error("TRANSLATION_NOT_ALLOWED")
        body = json.loads(row["body"])
        if body.get("provenance", {}).get("kind") != "asr":
            raise error("TRANSLATION_NOT_ALLOWED")
        if not any(s.get("id") == segment_id for s in body.get("segments", [])):
            raise error("SEGMENT_NOT_FOUND")

    def _cached(self, episode_id: str, segment_id: str, fp: str) -> TranslationResult | None:
        with self.db.tx() as conn:
            row = conn.execute(
                "SELECT text, created_at FROM translations WHERE episode_id = ? AND "
                "segment_id = ? AND source_fingerprint = ? AND provider = ? AND target_lang = ? "
                "AND cache_version = ?",
                (
                    episode_id,
                    segment_id,
                    fp,
                    TRANSLATION_PROVIDER,
                    TRANSLATION_TARGET_LANGUAGE,
                    TRANSLATION_CACHE_VERSION,
                ),
            ).fetchone()
        if row is None:
            return None
        return self._result(episode_id, segment_id, fp, row["text"], "cache", row["created_at"])

    def _consent_current(self, conn: sqlite3.Connection | None = None) -> bool:
        def check(c: sqlite3.Connection) -> bool:
            row = c.execute(
                "SELECT consent_version FROM translation_consent WHERE provider = ?",
                (TRANSLATION_PROVIDER,),
            ).fetchone()
            return row is not None and row["consent_version"] == CONSENT_VERSION

        if conn is not None:
            return check(conn)
        with self.db.tx() as c:
            return check(c)

    def _reserve(self, episode_id: str, characters: int) -> str:
        """One transaction: consent, episode, limits, then the reservation and its attempt."""
        period = current_period(self.clock())
        attempt_id = uuid.uuid4().hex
        now = now_iso()
        with self.db.tx() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if not self._consent_current(conn):
                raise error("TRANSLATION_CONSENT_REQUIRED")
            if (
                conn.execute("SELECT 1 FROM episodes WHERE id = ?", (episode_id,)).fetchone()
                is None
            ):
                raise error("EPISODE_NOT_FOUND")
            used = conn.execute(
                "SELECT requests, characters FROM translation_usage WHERE period = ?", (period,)
            ).fetchone()
            requests, chars = (used["requests"], used["characters"]) if used else (0, 0)
            if (
                requests + 1 > self.settings.monthly_request_limit
                or chars + characters > self.settings.monthly_character_limit
            ):
                raise error("TRANSLATION_LOCAL_LIMIT")
            conn.execute(
                "INSERT INTO translation_usage (period, requests, characters) VALUES (?, 1, ?) "
                "ON CONFLICT (period) DO UPDATE SET requests = requests + 1, "
                "characters = characters + excluded.characters",
                (period, characters),
            )
            conn.execute(
                "INSERT INTO translation_attempts (id, period, characters, consent_version, "
                "status, created_at, updated_at) VALUES (?, ?, ?, ?, 'reserved', ?, ?)",
                (attempt_id, period, characters, CONSENT_VERSION, now, now),
            )
        return attempt_id

    def _finish(
        self, attempt_id: str, status: str, code: str | None, http_status: int | None
    ) -> None:
        with self.db.tx() as conn:
            conn.execute(
                "UPDATE translation_attempts SET status = ?, failure_code = ?, http_status = ?, "
                "updated_at = ? WHERE id = ?",
                (status, code, http_status, now_iso(), attempt_id),
            )

    def _store(
        self,
        attempt_id: str,
        episode_id: str,
        segment_id: str,
        fp: str,
        characters: int,
        english: str,
    ) -> TranslationResult:
        """Stores the result only if its episode still exists; never restores a deleted one."""
        created_at = now_iso()
        stored = False
        try:
            with self.db.tx() as conn:
                conn.execute("BEGIN IMMEDIATE")
                if conn.execute("SELECT 1 FROM episodes WHERE id = ?", (episode_id,)).fetchone():
                    conn.execute(
                        "INSERT OR IGNORE INTO translations (episode_id, segment_id, "
                        "source_fingerprint, provider, target_lang, cache_version, source_chars, "
                        "text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            episode_id,
                            segment_id,
                            fp,
                            TRANSLATION_PROVIDER,
                            TRANSLATION_TARGET_LANGUAGE,
                            TRANSLATION_CACHE_VERSION,
                            characters,
                            english,
                            created_at,
                        ),
                    )
                    stored = True
        except sqlite3.IntegrityError:
            stored = False  # the episode went away mid-transaction (foreign key)
        self._finish(attempt_id, "succeeded", None, 200)
        if not stored:
            raise error("EPISODE_NOT_FOUND")
        return self._result(episode_id, segment_id, fp, english, "provider", created_at)

    def _provider(self) -> DeepLClient:
        if self._client is None:
            self._client = self._client_factory(self.settings)
        return self._client

    @staticmethod
    def _result(
        episode_id: str, segment_id: str, fp: str, text: str, source: str, created_at: str
    ) -> TranslationResult:
        return TranslationResult.model_validate(
            {
                "schemaVersion": CURRENT_SCHEMA_VERSION,
                "episodeId": episode_id,
                "segmentId": segment_id,
                "fingerprint": fp,
                "provider": TRANSLATION_PROVIDER,
                "targetLanguage": TRANSLATION_TARGET_LANGUAGE,
                "text": text,
                "source": source,
                "createdAt": created_at,
            }
        )
