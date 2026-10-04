"""The transcription-provider boundary: the mock (M0C) and FunASR (M1)."""

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
    #: Machine-readable state (schema 1.5): ready, checking, environment_missing,
    #: models_missing, verification_failed or load_failed. `detail` is for developers.
    state: str = "ready"
    #: Plain-language remediation for the local app, with at most one command (schema 1.5).
    hint: str | None = None


@dataclass(frozen=True)
class ModelRef:
    role: Literal["asr", "vad", "punctuation"]
    id: str
    revision: str


@dataclass(frozen=True)
class ProvenanceDetails:
    """Extra provenance an ASR provider records on every transcript (schema 1.4)."""

    models: tuple[ModelRef, ...]
    runtime: dict[str, str]


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
    #: Provider-detected structural review flags (see pipeline/review.py). Never confidence.
    review_flags: tuple[str, ...] = ()


class TranscriptionProvider(Protocol):
    id: str
    kind: Literal["mock", "asr"]
    model: str | None
    script: Literal["simplified", "traditional", "unknown"]
    capabilities: Capabilities
    provenance_note: str

    def health(self) -> ProviderHealth:
        """Cheap and non-blocking: called on every /health request."""
        ...

    def prepare(self, *, wait: bool = False) -> None:
        """Starts any background readiness checks (at worker startup); `wait` blocks for them."""
        ...

    def provenance_details(self) -> ProvenanceDetails | None:
        """Model and runtime provenance for ASR output; None for the mock."""
        ...

    def transcribe(self, chunk: AudioChunk, cancel: CancelCheck) -> list[RawSegment]:
        """Raise PipelineError(PROVIDER_*) on failure, Cancelled when `cancel()` turns true."""
        ...
