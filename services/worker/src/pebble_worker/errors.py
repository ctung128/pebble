"""Structured failures. Every job failure is reported as {stage, code, message, retryable, hint}."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class FailureCode(StrEnum):
    FFMPEG_NOT_FOUND = "FFMPEG_NOT_FOUND"
    UNSUPPORTED_MEDIA = "UNSUPPORTED_MEDIA"
    NO_AUDIO_STREAM = "NO_AUDIO_STREAM"
    AUDIO_TOO_LONG = "AUDIO_TOO_LONG"
    STORAGE_ERROR = "STORAGE_ERROR"
    PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE"
    PROVIDER_ERROR = "PROVIDER_ERROR"
    NO_SPEECH_DETECTED = "NO_SPEECH_DETECTED"
    WORKER_RESTARTED = "WORKER_RESTARTED"
    CANCELLED = "CANCELLED"
    INTERNAL_ERROR = "INTERNAL_ERROR"


# Whether retrying can plausibly succeed without the user changing anything.
RETRYABLE: dict[FailureCode, bool] = {
    FailureCode.FFMPEG_NOT_FOUND: True,
    FailureCode.UNSUPPORTED_MEDIA: False,
    FailureCode.NO_AUDIO_STREAM: False,
    FailureCode.AUDIO_TOO_LONG: False,
    FailureCode.STORAGE_ERROR: True,
    FailureCode.PROVIDER_UNAVAILABLE: True,
    FailureCode.PROVIDER_ERROR: True,
    FailureCode.NO_SPEECH_DETECTED: False,  # the same audio gives the same result
    FailureCode.WORKER_RESTARTED: True,
    FailureCode.CANCELLED: True,
    FailureCode.INTERNAL_ERROR: True,
}


@dataclass
class PipelineError(Exception):
    """A failure the pipeline can describe to the user."""

    code: FailureCode
    message: str
    hint: str | None = None
    retryable: bool | None = None

    def __post_init__(self) -> None:
        super().__init__(self.message)
        if self.retryable is None:
            self.retryable = RETRYABLE[self.code]


class Cancelled(Exception):
    """Raised at a safe checkpoint when cancellation was requested."""


class ConfigError(ValueError):
    """Invalid worker configuration; the worker refuses to start."""


class StorageAccessError(PermissionError):
    """A path resolved outside the Pebble data directory."""
