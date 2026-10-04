"""
Structural review flags for ASR transcripts (schema 1.4).

These are deterministic, non-probabilistic notes about a segment's *shape*, computed from its
timing alone (plus one provider-reported check). They are not confidence, never displayed as
confidence, and never used to rewrite, merge or split text. Their purpose is evidence for
human review and benchmarking (M1-B).

- `long_segment`: duration > `long_segment_ms` (default 7000).
- `short_fragment`: duration < `short_fragment_ms` (default 800).
- `speech_gap`: the gap since the previous segment's end (or since 0 ms, for the first
  segment) > `speech_gap_ms` (default 2000).
- `timestamp_alignment_anomaly`: set by the provider when a sentence's text and its
  per-character timestamps don't correspond (see providers/funasr.py).

A gap after the last segment is not flagged.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from ..errors import ConfigError

REVIEW_FLAGS = ("long_segment", "short_fragment", "timestamp_alignment_anomaly", "speech_gap")


@dataclass(frozen=True)
class ReviewConfig:
    long_segment_ms: int = 7000
    short_fragment_ms: int = 800
    speech_gap_ms: int = 2000

    def __post_init__(self) -> None:
        if min(self.long_segment_ms, self.short_fragment_ms, self.speech_gap_ms) <= 0:
            raise ConfigError("Review thresholds must be positive.")
        if self.short_fragment_ms >= self.long_segment_ms:
            raise ConfigError("The short-fragment threshold must be below the long-segment one.")

    def as_contract(self) -> dict[str, int]:
        return {
            "longSegmentMs": self.long_segment_ms,
            "shortFragmentMs": self.short_fragment_ms,
            "speechGapMs": self.speech_gap_ms,
        }


def review_flags(
    spans: Sequence[tuple[int, int, Sequence[str]]], config: ReviewConfig
) -> list[list[str]]:
    """
    `spans` are ordered `(start_ms, end_ms, provider_flags)`. Returns each segment's flags in
    the canonical order of REVIEW_FLAGS, keeping provider flags and adding timing flags.
    """
    result: list[list[str]] = []
    previous_end = 0
    for start, end, provider_flags in spans:
        flags = set(provider_flags)
        duration = end - start
        if duration > config.long_segment_ms:
            flags.add("long_segment")
        if duration < config.short_fragment_ms:
            flags.add("short_fragment")
        if start - previous_end > config.speech_gap_ms:
            flags.add("speech_gap")
        unknown = flags - set(REVIEW_FLAGS)
        if unknown:
            raise ValueError(f"Unknown review flags: {sorted(unknown)}")
        result.append([flag for flag in REVIEW_FLAGS if flag in flags])
        previous_end = max(previous_end, end)
    return result
