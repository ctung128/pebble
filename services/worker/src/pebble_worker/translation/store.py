"""
Translation consent and usage in the worker's SQLite database (migration 2). Local only: nothing
here makes a network call.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from ..contract import (
    CURRENT_SCHEMA_VERSION,
    TRANSLATION_PROVIDER,
    TranslationConsent,
    TranslationHealth,
)
from ..db import Database, now_iso
from .config import TranslationSettings

#: The consent a learner gives in the dialog (docs/TRANSLATION.md). Changing the dialog's
#: wording or what is sent means a new version, which asks again.
CONSENT_VERSION = "deepl-2026-10"


def current_period(now: datetime | None = None) -> str:
    """The UTC calendar month Pebble's limits count in, as "YYYY-MM"."""
    return (now or datetime.now(UTC)).astimezone(UTC).strftime("%Y-%m")


@dataclass(frozen=True)
class Usage:
    requests: int
    characters: int


def usage(db: Database, period: str) -> Usage:
    with db.tx() as conn:
        row = conn.execute(
            "SELECT requests, characters FROM translation_usage WHERE period = ?", (period,)
        ).fetchone()
    return Usage(row["requests"], row["characters"]) if row else Usage(0, 0)


def _granted_at(db: Database) -> str | None:
    """When the *current* consent version was accepted; None if not, or an older version."""
    with db.tx() as conn:
        row = conn.execute(
            "SELECT consent_version, granted_at FROM translation_consent WHERE provider = ?",
            (TRANSLATION_PROVIDER,),
        ).fetchone()
    if row is None or row["consent_version"] != CONSENT_VERSION:
        return None
    return row["granted_at"]


def consent_status(db: Database) -> TranslationConsent:
    granted_at = _granted_at(db)
    return TranslationConsent.model_validate(
        {
            "schemaVersion": CURRENT_SCHEMA_VERSION,
            "provider": TRANSLATION_PROVIDER,
            "status": "current" if granted_at else "required",
            "consentVersion": CONSENT_VERSION,
            "grantedAt": granted_at,
        }
    )


def grant_consent(db: Database) -> TranslationConsent:
    """Records consent to the current version, for every browser using this worker."""
    with db.tx() as conn:
        conn.execute(
            """
            INSERT INTO translation_consent (provider, consent_version, granted_at)
            VALUES (?, ?, ?)
            ON CONFLICT (provider) DO UPDATE SET
              consent_version = excluded.consent_version,
              granted_at = excluded.granted_at
            """,
            (TRANSLATION_PROVIDER, CONSENT_VERSION, now_iso()),
        )
    return consent_status(db)


def withdraw_consent(db: Database) -> TranslationConsent:
    """Stops future submissions. Idempotent; cached English is kept and stays readable."""
    with db.tx() as conn:
        conn.execute("DELETE FROM translation_consent WHERE provider = ?", (TRANSLATION_PROVIDER,))
    return consent_status(db)


def translation_health(
    settings: TranslationSettings, db: Database, now: datetime | None = None
) -> TranslationHealth:
    """The health block. Separate facts; reading cached English depends on none of them."""
    period = current_period(now)
    used = usage(db, period)
    limits = {
        "period": period,
        "requestsUsed": used.requests,
        "requestLimit": settings.monthly_request_limit,
        "charactersUsed": used.characters,
        "characterLimit": settings.monthly_character_limit,
    }
    if not settings.configured:
        consent, new_requests = "not_configured", "off"
    elif _granted_at(db) is None:
        consent, new_requests = "required", "consent_required"
    else:
        at_limit = (
            used.requests >= settings.monthly_request_limit
            or used.characters >= settings.monthly_character_limit
        )
        consent, new_requests = "current", "local_limit_reached" if at_limit else "available"
    return TranslationHealth.model_validate(
        {
            "provider": TRANSLATION_PROVIDER,
            "configured": settings.configured,
            "consent": consent,
            "consentVersion": CONSENT_VERSION,
            "newRequests": new_requests,
            "limits": limits,
        }
    )
