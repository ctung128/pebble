"""The transcription-provider boundary. M0C ships only the mock; FunASR arrives in M1."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

from ..pipeline.tools import CancelCheck


@dataclass(frozen=True)
class Capabilities:
    word_timestamps: bool
    confidence: bool
    punctuation: bool


@dataclass(frozen=True)
class ProviderHealth:
    available: bool
    detail: str | None


@dataclass(frozen=True)
class AudioChunk:
    index: int
    start_ms: int
    end_ms: int
    path: Path  # 16 kHz mono PCM WAV

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


@dataclass(frozen=True)
class RawSegment:
    """Provider output with times relative to the chunk start."""

    start_ms: int
    end_ms: int
    text: str
    confidence: float | None = None  # only when the provider genuinely reports it
    speaker: str | None = None


class TranscriptionProvider(Protocol):
    id: str
    kind: Literal["mock", "asr"]
    model: str | None
    script: Literal["simplified", "traditional", "unknown"]
    capabilities: Capabilities
    provenance_note: str

    def health(self) -> ProviderHealth: ...

    def transcribe(self, chunk: AudioChunk, cancel: CancelCheck) -> list[RawSegment]:
        """Raise PipelineError(PROVIDER_*) on failure, Cancelled when `cancel()` turns true."""
        ...
