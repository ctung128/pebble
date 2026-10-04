"""
Mock provider: deterministic placeholder text for testing the pipeline. It never listens to
the audio — its output is labelled `mock` everywhere and must never be used for learning.
"""

from __future__ import annotations

import time
from typing import Literal

from ..errors import Cancelled, FailureCode, PipelineError
from ..pipeline.tools import CancelCheck
from .base import AudioChunk, Capabilities, ProviderHealth, RawSegment

SEGMENT_MS = 4000
MIN_TAIL_MS = 1000


class MockProvider:
    id = "mock"
    kind: Literal["mock"] = "mock"
    model = None
    script: Literal["simplified"] = "simplified"
    capabilities = Capabilities(word_timestamps=False, confidence=False, punctuation=False)
    provenance_note = "Placeholder text from the mock provider; not a transcription of the audio."

    def __init__(self, *, delay_ms: int = 300, fail_at_chunk: int | None = None) -> None:
        self.delay_ms = delay_ms
        #: 1-based chunk number to fail on, simulating a provider error.
        self.fail_at_chunk = fail_at_chunk

    def health(self) -> ProviderHealth:
        return ProviderHealth(
            available=True,
            detail="Placeholder text for pipeline testing; not speech recognition.",
        )

    def prepare(self, *, wait: bool = False) -> None:
        return None

    def provenance_details(self) -> None:
        return None

    def transcribe(self, chunk: AudioChunk, cancel: CancelCheck) -> list[RawSegment]:
        deadline = time.monotonic() + self.delay_ms / 1000
        while time.monotonic() < deadline:
            if cancel():
                raise Cancelled()
            time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
        if cancel():
            raise Cancelled()
        if self.fail_at_chunk == chunk.index + 1:
            raise PipelineError(
                FailureCode.PROVIDER_ERROR,
                f"The mock provider failed on chunk {chunk.index + 1} (simulated).",
                hint="Retry the job. Unset PEBBLE_MOCK_FAIL_AT_CHUNK to stop simulating failures.",
            )
        return self.placeholder_segments(chunk)

    @staticmethod
    def placeholder_segments(chunk: AudioChunk) -> list[RawSegment]:
        bounds: list[tuple[int, int]] = []
        start = 0
        while start < chunk.duration_ms:
            end = min(start + SEGMENT_MS, chunk.duration_ms)
            if end - start < MIN_TAIL_MS and bounds:
                bounds[-1] = (bounds[-1][0], end)  # fold a short tail into the previous segment
            else:
                bounds.append((start, end))
            start = end
        return [
            RawSegment(s, e, f"（模拟转写）第 {chunk.index + 1}-{n + 1} 段")
            for n, (s, e) in enumerate(bounds)
        ]
