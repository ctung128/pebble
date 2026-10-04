"""Builds the provider PEBBLE_PROVIDER selects. There is no fallback between providers."""

from __future__ import annotations

from ..config import Settings
from ..storage import Storage
from .base import TranscriptionProvider
from .mock import MockProvider


def build_provider(settings: Settings, storage: Storage) -> TranscriptionProvider:
    if settings.provider == "funasr":
        # Importing this module is cheap: FunASR itself loads on the first transcription.
        from .funasr import FunASRProvider

        return FunASRProvider(storage)
    if settings.provider == "mock":
        return MockProvider(
            delay_ms=settings.mock_delay_ms, fail_at_chunk=settings.mock_fail_at_chunk
        )
    raise ValueError(f"Unknown provider {settings.provider!r}")  # Settings already refuses this
