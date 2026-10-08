"""
Local, whole-episode speaker diarization (ADR 0009): the synthetic-tested core.

Input is an episode's 16 kHz mono WAV and its transcript lines as **ids and times only**; the core
never sees transcript text, so speaker labels can't leak into text (or into DeepL requests).

1. Every line is cut into 1.5 s windows with a 0.75 s shift (FunASR's `sv_chunk` rule), read from
   the WAV one line at a time.
2. The windows are embedded in batches by an `Embedder`; the embeddings exist only in memory.
3. All of the episode's embeddings are clustered **once** by a `Clusterer`, so identity holds
   across the whole episode.
4. Speaker IDs are generic and episode-local, `S1`, `S2`, … in order of first appearance in time,
   whatever numbers the clusterer used. Each line gets the speaker holding most of its windows
   (ties: the one heard first in the line); a line with no windows, or only noise windows (`-1`),
   is unassigned (`None`).

Cancellation is checked before reading, between embedding batches, and around clustering. The
core writes no files; `temporary_normalized` gives callers a scratch WAV that is always removed.
"""

from __future__ import annotations

import shutil
import tempfile
import wave
from collections import Counter
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol

from ..errors import Cancelled
from ..pipeline.tools import CancelCheck, never_cancelled
from ..storage import PRIVATE_DIR, make_private

SAMPLE_RATE = 16000
WINDOW_SAMPLES = 24000  # 1.5 s
SHIFT_SAMPLES = 12000  # 0.75 s
EMBED_BATCH = 64
NOISE = -1

SpeakerErrorCode = Literal[
    "SPEAKER_MODEL_UNAVAILABLE",
    "AUDIO_UNAVAILABLE",
    "INVALID_INPUT",
    "EMBEDDING_FAILED",
    "CLUSTERING_FAILED",
]


class SpeakerRunError(Exception):
    """A speaker run failed. Messages contain no transcript text, audio or paths."""

    def __init__(self, code: SpeakerErrorCode, message: str, *, retryable: bool = True) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


@dataclass(frozen=True)
class LineSpan:
    """A transcript line as the core sees it: id and times, never text."""

    segment_id: str
    start_ms: int
    end_ms: int


class Embedder(Protocol):
    def __call__(self, windows: list[Any]) -> Any:
        """`windows`: float32 arrays of WINDOW_SAMPLES → an (n, dim) float array."""
        ...


class Clusterer(Protocol):
    def __call__(self, embeddings: Any) -> tuple[list[int], str]:
        """Labels (one per row, `-1` for noise) and the clustering branch that ran."""
        ...


@dataclass(frozen=True)
class Speaker:
    id: str
    lines: int
    windows: int


@dataclass(frozen=True)
class DiarizationResult:
    assignments: dict[str, str | None]  # segment id → speaker id, or None (unassigned)
    speakers: tuple[Speaker, ...]  # in ID order
    windows: int
    noise_windows: int
    unassigned_lines: int
    clustering: str


# --- windows ------------------------------------------------------------------------------------


def window_spans(samples: int) -> list[tuple[int, int]]:
    """
    Sample ranges FunASR's `sv_chunk` cuts from a region of `samples` samples: windows start every
    SHIFT_SAMPLES; the last one is moved back to end at the region's end; a region shorter than a
    window gives one short window (zero-padded when read).
    """
    spans: list[tuple[int, int]] = []
    last_end = 0
    for start in range(0, samples, SHIFT_SAMPLES):
        end = min(start + WINDOW_SAMPLES, samples)
        if end <= last_end:
            break
        last_end = end
        spans.append((max(0, end - WINDOW_SAMPLES), end))
    return spans


def window_count(duration_ms: int) -> int:
    return len(window_spans(max(0, duration_ms) * SAMPLE_RATE // 1000))


def _check_lines(lines: Sequence[LineSpan]) -> None:
    ids = [line.segment_id for line in lines]
    if len(set(ids)) != len(ids) or any(not i for i in ids):
        raise SpeakerRunError(
            "INVALID_INPUT", "Line ids must be unique and non-empty.", retryable=False
        )
    if any(line.start_ms < 0 or line.end_ms <= line.start_ms for line in lines):
        raise SpeakerRunError("INVALID_INPUT", "A line has invalid timing.", retryable=False)


def iter_windows(
    audio: Path, lines: Sequence[LineSpan], cancel: CancelCheck = never_cancelled
) -> Iterator[tuple[int, Any]]:
    """`(line index, float32 window)` in line order, reading one line's audio at a time."""
    import numpy

    try:
        source = wave.open(str(audio), "rb")  # noqa: SIM115 — closed by the `with` below
    except (OSError, EOFError, wave.Error) as error:
        raise SpeakerRunError(
            "AUDIO_UNAVAILABLE", "The episode's audio couldn't be read."
        ) from error
    with source:
        if (source.getframerate(), source.getnchannels(), source.getsampwidth()) != (
            SAMPLE_RATE,
            1,
            2,
        ):
            raise SpeakerRunError(
                "AUDIO_UNAVAILABLE", "The audio isn't 16 kHz mono 16-bit.", retryable=False
            )
        total = source.getnframes()
        for index, line in enumerate(lines):
            if cancel():
                raise Cancelled()
            first = min(total, line.start_ms * SAMPLE_RATE // 1000)
            last = min(total, line.end_ms * SAMPLE_RATE // 1000)
            if last <= first:
                continue  # entirely past the end of the audio: no windows, so unassigned
            source.setpos(first)
            region = numpy.frombuffer(source.readframes(last - first), dtype="<i2")
            for start, end in window_spans(len(region)):
                window = numpy.zeros(WINDOW_SAMPLES, dtype=numpy.float32)
                window[: end - start] = region[start:end].astype(numpy.float32) / 32768.0
                yield index, window


# --- labels -------------------------------------------------------------------------------------


def assign_lines(
    window_lines: Sequence[int], labels: Sequence[int], line_count: int
) -> tuple[list[str | None], dict[int, str]]:
    """
    Each line's speaker ID by majority of its windows (noise excluded; ties go to the label heard
    first in the line), and the cluster → ID map. IDs are `S1`, `S2`, … in order of each
    cluster's first window in time, so they don't depend on the clusterer's numbering.
    """
    if len(window_lines) != len(labels):
        raise SpeakerRunError(
            "CLUSTERING_FAILED", "The clusterer returned the wrong number of labels."
        )
    names: dict[int, str] = {}
    for label in labels:
        if label != NOISE and label not in names:
            names[label] = f"S{len(names) + 1}"
    votes: list[list[int]] = [[] for _ in range(line_count)]
    for line, label in zip(window_lines, labels, strict=True):
        if label != NOISE:
            votes[line].append(label)
    speakers: list[str | None] = []
    for own in votes:
        if not own:
            speakers.append(None)
            continue
        counts = Counter(own)
        best = min(counts, key=lambda label: (-counts[label], own.index(label)))
        speakers.append(names[best])
    return speakers, names


# --- the run ------------------------------------------------------------------------------------


def diarize(
    audio: Path,
    lines: Sequence[LineSpan],
    *,
    embedder: Embedder,
    clusterer: Clusterer,
    cancel: CancelCheck = never_cancelled,
    batch_size: int = EMBED_BATCH,
) -> DiarizationResult:
    """One whole-episode run. Raises SpeakerRunError on failure and Cancelled on request."""
    import numpy

    _check_lines(lines)
    if cancel():
        raise Cancelled()
    batches: list[Any] = []
    window_lines: list[int] = []
    pending: list[Any] = []
    pending_lines: list[int] = []

    def flush() -> None:
        if not pending:
            return
        if cancel():
            raise Cancelled()
        try:
            embedded = numpy.asarray(embedder(pending), dtype=numpy.float32)
        except (SpeakerRunError, Cancelled):
            raise
        except Exception as error:
            raise SpeakerRunError(
                "EMBEDDING_FAILED", f"Speaker embedding failed ({type(error).__name__})."
            ) from error
        if (
            embedded.ndim != 2
            or embedded.shape[0] != len(pending)
            or not numpy.isfinite(embedded).all()
        ):
            raise SpeakerRunError("EMBEDDING_FAILED", "The speaker model returned unusable output.")
        batches.append(embedded)
        window_lines.extend(pending_lines)
        pending.clear()
        pending_lines.clear()

    for index, window in iter_windows(audio, lines, cancel):
        pending.append(window)
        pending_lines.append(index)
        if len(pending) >= batch_size:
            flush()
    flush()

    if not window_lines:
        labels: list[int] = []
        clustering = "none"
    else:
        embeddings = numpy.concatenate(batches)
        batches.clear()
        if cancel():
            raise Cancelled()
        try:
            labels, clustering = clusterer(embeddings)
        except (SpeakerRunError, Cancelled):
            raise
        except Exception as error:
            raise SpeakerRunError(
                "CLUSTERING_FAILED", f"Speaker clustering failed ({type(error).__name__})."
            ) from error
        finally:
            del embeddings  # never kept or written
        if cancel():
            raise Cancelled()
    speakers, names = assign_lines(window_lines, [int(label) for label in labels], len(lines))
    line_counts = Counter(s for s in speakers if s is not None)
    window_counts = Counter(names[label] for label in labels if label != NOISE)
    return DiarizationResult(
        assignments={
            line.segment_id: speaker for line, speaker in zip(lines, speakers, strict=True)
        },
        speakers=tuple(
            Speaker(name, line_counts[name], window_counts[name])
            for name in sorted(names.values(), key=lambda n: int(n[1:]))
        ),
        windows=len(window_lines),
        noise_windows=sum(1 for label in labels if label == NOISE),
        unassigned_lines=sum(1 for s in speakers if s is None),
        clustering=clustering,
    )


@contextmanager
def temporary_normalized(
    source: Path,
    scratch_parent: Path,
    normalize: Callable[[Path, Path], int],
) -> Iterator[Path]:
    """
    A private scratch copy of `source` normalized to 16 kHz mono WAV, for an episode whose own
    normalized audio is gone. The scratch directory is removed on every exit: success, failure or
    cancellation.
    """
    scratch_parent.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR)
    directory = Path(tempfile.mkdtemp(prefix="speakers-", dir=scratch_parent))
    make_private(directory)
    try:
        target = directory / "normalized.wav"
        try:
            normalize(source, target)
        except Cancelled:
            raise
        except Exception as error:
            raise SpeakerRunError(
                "AUDIO_UNAVAILABLE", "The episode's audio couldn't be prepared."
            ) from error
        yield target
    finally:
        shutil.rmtree(directory, ignore_errors=True)
