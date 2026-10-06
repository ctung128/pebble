"""
FunASR provider (M1): SeACo-Paraformer speech recognition with FSMN-VAD and CT-Transformer
punctuation, on the CPU, from the pinned local models in `<data>/models` (docs/MODELS.md).

- Selected only with PEBBLE_PROVIDER=funasr; never falls back to the mock.
- Nothing heavy is imported until the first transcription: then the model files are
  verified (size + SHA-256) and FunASR loads them from their local folders with its update
  check off, so normal operation makes no network calls.
- Segment boundaries come only from FunASR's `sentence_info`. Anything that can't be
  normalized safely fails clearly; nothing is guessed, merged, split or rewritten.
- `confidence` is always None: FunASR reports no confidence for these models.
"""

from __future__ import annotations

import importlib.metadata
import importlib.util
import logging
import math
import os
import re
import threading
import unicodedata
import wave
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol

from ..errors import Cancelled, FailureCode, PipelineError
from ..models.manifest import CT_PUNC_ZH, FSMN_VAD, PARAFORMER, ModelSpec
from ..models.pull import hub_environment
from ..models.verify import file_path, model_dir, verify_model
from ..pipeline.tools import CancelCheck
from ..storage import Storage
from .base import (
    AudioChunk,
    Capabilities,
    ModelRef,
    ProvenanceDetails,
    ProviderHealth,
    RawSegment,
)

log = logging.getLogger("pebble.funasr")

SAMPLE_RATE = 16000
#: How far a sentence may end past its chunk's end (frame rounding), as in the transcript schema.
BOUND_TOLERANCE_MS = 500
#: Adjacent sentences may overlap by at most this much; more fails normalization.
OVERLAP_TOLERANCE_MS = 100

MODELS: Mapping[Literal["asr", "vad", "punctuation"], ModelSpec] = {
    "asr": PARAFORMER,
    "vad": FSMN_VAD,
    "punctuation": CT_PUNC_ZH,
}

INSTALL_HINT = "Set it up with: npm run pebble:setup, then start Pebble again."
PULL_HINT = "Download and verify the models with: npm run pebble:setup"

#: Plain-language remediation shown in the local app (schema 1.5 `hint`): at most one command.
HINTS = {
    "environment_missing": (
        "Pebble's speech-recognition components aren't set up yet. Set them up with: "
        "npm run pebble:setup"
    ),
    "models_missing": "Download the speech models (about 1.3 GB) with: npm run pebble:setup",
    "verification_failed": (
        "The speech model files don't match what Pebble expects. Download them again with: "
        "npm run pebble:setup"
    ),
    "load_failed": (
        "The speech models couldn't be loaded. Stop Pebble and start it again. If it keeps "
        "happening, check the setup with: npm run pebble:doctor -- --verify"
    ),
}

_CJK = re.compile("[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_WORD = re.compile(r"[A-Za-z0-9]+")


class GenerateModel(Protocol):
    def generate(self, *, input: Any, **kwargs: Any) -> Any: ...


Loader = Callable[[Mapping[str, Path]], GenerateModel]
ProviderState = Literal[
    "ready",
    "checking",
    "environment_missing",
    "models_missing",
    "verification_failed",
    "load_failed",
]
#: (relative path, size, mtime_ns) of every manifest file: verification is valid for one value.
Signature = tuple[tuple[str, int, int], ...]


class NormalizationError(Exception):
    """FunASR output that cannot be turned into timed segments without guessing."""


def installed_runtime() -> dict[str, str] | None:
    """Package versions from metadata (nothing is imported); None if FunASR is not installed."""
    if importlib.util.find_spec("funasr") is None:
        return None
    versions = {}
    for package in ("funasr", "torch", "torchaudio", "modelscope"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            return None
    return versions


class FunASRProvider:
    id = "funasr"
    kind: Literal["asr"] = "asr"
    model = PARAFORMER.model_id
    script: Literal["simplified"] = "simplified"
    capabilities = Capabilities(word_timestamps=False, confidence=False, punctuation=True)
    provenance_note = "Transcribed on this computer with FunASR Paraformer"

    def __init__(
        self,
        storage: Storage,
        *,
        loader: Loader | None = None,
        runtime: Callable[[], dict[str, str] | None] = installed_runtime,
        reader: Callable[[AudioChunk], Any] | None = None,
        models: Mapping[Literal["asr", "vad", "punctuation"], ModelSpec] = MODELS,
    ) -> None:
        self.storage = storage
        self.models = models
        self._loader = loader or self._load_funasr
        self._reader = reader or read_chunk
        self._runtime = runtime()
        self._lock = threading.Lock()  # loading and transcription
        self._check_lock = threading.Lock()  # verification bookkeeping only; never held long
        self._check_thread: threading.Thread | None = None
        self._model: GenerateModel | None = None
        #: Files as they were when they last passed / failed full SHA-256 verification.
        self._verified: Signature | None = None
        self._failed: tuple[Signature, str] | None = None
        self._load_failure: str | None = None
        #: The last transcribed chunk's alignment diagnostic (numbers only), for `bench`.
        self.last_alignment: ChunkAlignment | None = None

    # --- health -----------------------------------------------------------------------------

    def health(self) -> ProviderHealth:
        """
        Cheap and non-blocking (file stats only; no hashing, no imports), so it is safe on every
        /health poll. Full verification runs in the background (`prepare`); until it has passed
        for the files as they are now, the state is `checking`.
        """
        if self._runtime is None:
            return self._unavailable(
                "environment_missing", f"FunASR is not installed. {INSTALL_HINT}"
            )
        missing = 0
        wrong_size = 0
        for spec in self.models.values():
            for file in spec.files:
                path = file_path(self.storage, spec, file)
                if not path.is_file():
                    missing += 1
                elif path.stat().st_size != file.size:
                    wrong_size += 1
        total = sum(len(spec.files) for spec in self.models.values())
        if missing:
            return self._unavailable(
                "models_missing",
                f"Speech model files are missing ({missing} of {total}). {PULL_HINT}",
            )
        if wrong_size:
            return self._unavailable(
                "verification_failed",
                f"{wrong_size} speech model file(s) have the wrong size. Check them with "
                f"npm run worker:models -- verify, then {PULL_HINT[0].lower()}{PULL_HINT[1:]}",
            )
        if self._load_failure is not None:
            return self._unavailable("load_failed", self._load_failure)
        signature = self._signature()
        with self._check_lock:
            verified = signature is not None and signature == self._verified
            failed = self._failed if self._failed and self._failed[0] == signature else None
        if verified:
            if self._model is not None:
                return ProviderHealth(True, "FunASR Paraformer is loaded (CPU).", "ready")
            return ProviderHealth(
                True,
                "FunASR Paraformer is ready (CPU). Models are verified; they load when the "
                "first transcription starts, which takes a little longer.",
                "ready",
            )
        if failed is not None:
            return self._unavailable("verification_failed", failed[1])
        self.prepare()
        return ProviderHealth(False, "Verifying the speech model files…", "checking")

    def prepare(self, *, wait: bool = False) -> None:
        """
        Starts full model verification (size + SHA-256, local files only; nothing is loaded or
        downloaded) in the background unless the current files already have a result.
        With `wait`, blocks until it has finished (doctor, and a job that needs the result).
        """
        if self._runtime is None:
            return
        with self._check_lock:
            thread = self._check_thread
            if thread is None or not thread.is_alive():
                signature = self._signature()
                known = signature is not None and (
                    signature == self._verified or (self._failed or (None,))[0] == signature
                )
                if signature is None or known:
                    thread = None
                else:
                    thread = threading.Thread(
                        target=self._run_verification, name="pebble-model-check", daemon=True
                    )
                    self._check_thread = thread
                    thread.start()
        if wait and thread is not None:
            thread.join()

    def _run_verification(self) -> None:
        before = self._signature()
        reports = [verify_model(self.storage, spec) for spec in self.models.values()]
        after = self._signature()
        if before is None or before != after:
            return  # files changed while hashing; the next health check starts again
        missing = sum(r.status == "missing" for report in reports for r in report.files)
        failed = sum(r.status == "fail" for report in reports for r in report.files)
        with self._check_lock:
            if missing or failed:
                self._failed = (
                    after,
                    f"Speech model verification failed ({failed} failed, {missing} missing). "
                    f"Run npm run worker:models -- verify for details. {PULL_HINT}",
                )
                log.warning("model verification failed (%d failed, %d missing)", failed, missing)
            else:
                self._verified = after
                self._failed = None
                log.info("model verification passed")

    def _signature(self) -> Signature | None:
        entries = []
        for spec in self.models.values():
            for file in spec.files:
                path = file_path(self.storage, spec, file)
                try:
                    stat = path.lstat()
                except OSError:
                    return None
                entries.append((f"{spec.model_id}/{file.path}", stat.st_size, stat.st_mtime_ns))
        return tuple(entries)

    @staticmethod
    def _unavailable(state: ProviderState, detail: str) -> ProviderHealth:
        return ProviderHealth(False, detail, state, HINTS[state])

    def provenance_details(self) -> ProvenanceDetails:
        return ProvenanceDetails(
            models=tuple(
                ModelRef(role, spec.model_id, spec.revision) for role, spec in self.models.items()
            ),
            runtime={**(self._runtime or {}), "device": "cpu"},
        )

    # --- transcription ----------------------------------------------------------------------

    def transcribe(self, chunk: AudioChunk, cancel: CancelCheck) -> list[RawSegment]:
        self.last_alignment = None
        if cancel():
            raise Cancelled()
        model = self._ensure_loaded()
        audio = self._reader(chunk)
        if cancel():
            raise Cancelled()
        if len(audio) == 0:
            return []
        try:
            result = model.generate(input=audio, sentence_timestamp=True)
        except Exception as error:  # FunASR/torch errors; their messages never contain text
            log.error("chunk %d: FunASR failed: %s", chunk.index, type(error).__name__)
            raise PipelineError(
                FailureCode.PROVIDER_ERROR,
                f"FunASR failed while transcribing section {chunk.index + 1}.",
                hint="Retry. If it keeps failing, check ~/.pebble/logs/worker.log.",
            ) from error
        if cancel():
            raise Cancelled()
        log.info("chunk %d: output %s", chunk.index, describe_output(result))
        try:
            segments = normalize_output(result, chunk.duration_ms)
        except NormalizationError as error:
            log.error("chunk %d: normalization failed: %s", chunk.index, error)
            raise PipelineError(
                FailureCode.PROVIDER_ERROR,
                f"FunASR's output for section {chunk.index + 1} couldn't be turned into timed "
                f"lines: {error}.",
                hint="Pebble doesn't guess timings, so this audio can't be transcribed as is. "
                "The details are in ~/.pebble/logs/worker.log.",
                retryable=False,
            ) from error
        self.last_alignment = chunk_alignment(result)
        consistency = text_consistency(result)
        if consistency is not None:
            log.info("chunk %d: %s", chunk.index, consistency)
        return segments

    def load(self) -> None:
        """Verifies (if needed) and loads the models now rather than on the first chunk."""
        self._ensure_loaded()

    def _ensure_loaded(self) -> GenerateModel:
        with self._lock:
            if self._model is not None:
                return self._model
            if self._runtime is None:
                raise PipelineError(
                    FailureCode.PROVIDER_UNAVAILABLE,
                    "FunASR is not installed in the worker environment.",
                    hint=INSTALL_HINT,
                )
            # Reuse a verification of these exact files (same sizes and modification times);
            # anything else is verified again before loading.
            self.prepare(wait=True)
            signature = self._signature()
            with self._check_lock:
                verified = signature is not None and signature == self._verified
            if not verified:
                raise PipelineError(
                    FailureCode.PROVIDER_UNAVAILABLE,
                    "The speech model files failed verification, so Pebble won't load them.",
                    hint=PULL_HINT,
                )
            paths = {role: model_dir(self.storage, spec) for role, spec in self.models.items()}
            try:
                self._model = self._loader(paths)
            except Exception as error:
                log.exception("FunASR failed to load the models")
                self._load_failure = (
                    f"FunASR couldn't load the speech models ({type(error).__name__}). "
                    "Check ~/.pebble/logs/worker.log, run npm run worker:models -- verify, "
                    "then restart the worker."
                )
                raise PipelineError(
                    FailureCode.PROVIDER_UNAVAILABLE,
                    "FunASR couldn't load the speech models.",
                    hint="Check ~/.pebble/logs/worker.log and run npm run worker:models -- "
                    "verify, then restart the worker and retry.",
                ) from error
            self._load_failure = None
            log.info("FunASR models loaded (CPU)")
            return self._model

    def _load_funasr(self, paths: Mapping[str, Path]) -> GenerateModel:
        # Keep any ModelScope state inside the data directory, as `models pull` does.
        os.environ.update(hub_environment(self.storage))
        from funasr import AutoModel

        return AutoModel(
            model=str(paths["asr"]),
            vad_model=str(paths["vad"]),
            punc_model=str(paths["punctuation"]),
            device="cpu",
            disable_update=True,  # no PyPI version check
            check_latest=False,  # never ask the hub about local models
            disable_pbar=True,
        )


def read_chunk(chunk: AudioChunk) -> Any:
    """The chunk's 16 kHz mono 16-bit PCM WAV as float32 samples in [-1, 1)."""
    try:
        with wave.open(str(chunk.path), "rb") as wav:
            rate, channels, width = wav.getframerate(), wav.getnchannels(), wav.getsampwidth()
            frames = wav.readframes(wav.getnframes())
    except (OSError, EOFError, wave.Error) as error:
        raise PipelineError(
            FailureCode.UNSUPPORTED_MEDIA,
            f"Section {chunk.index + 1} couldn't be read as audio.",
            hint="Retry the job so Pebble normalizes the audio again.",
        ) from error
    if (rate, channels, width) != (SAMPLE_RATE, 1, 2):
        raise PipelineError(
            FailureCode.UNSUPPORTED_MEDIA,
            f"Section {chunk.index + 1} is not 16 kHz mono 16-bit audio, which FunASR requires.",
            hint="Retry the job so Pebble normalizes the audio again.",
        )
    import numpy

    return numpy.frombuffer(frames, dtype="<i2").astype(numpy.float32) / 32768.0


# --- normalization --------------------------------------------------------------------------


def normalize_output(result: Any, chunk_duration_ms: int) -> list[RawSegment]:
    """
    FunASR `generate()` output for one chunk → chunk-relative segments.

    Sentence boundaries come only from `sentence_info[*].start/end` (milliseconds). Character
    timestamps are used only to check that a sentence's text and timing correspond; a mismatch
    adds the `timestamp_alignment_anomaly` review flag and changes nothing else.
    """
    if not isinstance(result, list):
        raise NormalizationError(f"expected a list of results, got {type(result).__name__}")
    if not result:
        return []
    if len(result) != 1 or not isinstance(result[0], dict):
        raise NormalizationError("expected exactly one result for one section")
    item: dict[str, Any] = result[0]
    text = item.get("text")
    has_text = isinstance(text, str) and bool(text.strip())
    sentences = item.get("sentence_info")
    if sentences is None or sentences == []:
        if has_text:
            raise NormalizationError("text was recognized without sentence timing")
        return []  # no speech in this section
    if not isinstance(sentences, list):
        raise NormalizationError("sentence timing is not a list")

    segments: list[RawSegment] = []
    previous: tuple[int, int] | None = None
    for n, sentence in enumerate(sentences, start=1):
        if not isinstance(sentence, dict):
            raise NormalizationError(f"sentence {n} is not an object")
        start = _ms(sentence.get("start"), n, "start")
        end = _ms(sentence.get("end"), n, "end")
        sentence_text = sentence.get("text")
        if not isinstance(sentence_text, str) or not sentence_text.strip():
            raise NormalizationError(f"sentence {n} has no text")
        if end <= start:
            raise NormalizationError(f"sentence {n} ends before it starts")
        if start >= chunk_duration_ms or end > chunk_duration_ms + BOUND_TOLERANCE_MS:
            raise NormalizationError(f"sentence {n} lies outside the section")
        if previous is not None:
            if start < previous[0]:
                raise NormalizationError(f"sentence {n} starts before the previous sentence")
            if start < previous[1] - OVERLAP_TOLERANCE_MS:
                raise NormalizationError(f"sentence {n} overlaps the previous sentence")
        previous = (start, end)
        flags = (
            ()
            if alignment_issue(sentence_text, sentence.get("timestamp"), start, end) is None
            else ("timestamp_alignment_anomaly",)
        )
        segments.append(RawSegment(start, end, sentence_text.strip(), review_flags=flags))
    return segments


def _ms(value: Any, n: int, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise NormalizationError(f"sentence {n} has no valid {field} time")
    if not math.isfinite(value) or value < 0:
        raise NormalizationError(f"sentence {n} has no valid {field} time")
    return round(value)


AlignmentReason = Literal[
    "count_difference",
    "timestamp_outside_segment_range",
    "timestamps_out_of_order",
    "malformed_timestamps",
]


@dataclass(frozen=True)
class AlignmentIssue:
    """Why a sentence's text and its character timestamps don't correspond. Numbers only."""

    reason: AlignmentReason
    #: Timestamps minus text tokens (signed); set only for `count_difference`.
    count_difference: int | None = None


def text_tokens(text: str) -> int:
    """Each CJK character and each Latin letter/digit run; punctuation and spaces don't count."""
    return len(_CJK.findall(text)) + len(_WORD.findall(text))


def alignment_issue(text: str, timestamps: Any, start: int, end: int) -> AlignmentIssue | None:
    """
    None when there is nothing to contradict the sentence: no per-character timestamps, or one
    valid `[start, end]` pair per token, in order, inside the sentence. Otherwise the first
    reason found: malformed pairs, a count difference, pairs out of order, or a pair outside
    the sentence's range.
    """
    if timestamps is None:
        return None
    if not isinstance(timestamps, list) or not all(
        isinstance(pair, list | tuple)
        and len(pair) == 2
        and all(isinstance(v, int | float) and not isinstance(v, bool) for v in pair)
        for pair in timestamps
    ):
        return AlignmentIssue("malformed_timestamps")
    difference = len(timestamps) - text_tokens(text)
    if difference:
        return AlignmentIssue("count_difference", difference)
    previous_start = -math.inf
    for pair in timestamps:
        if pair[0] > pair[1] or pair[0] < previous_start:
            return AlignmentIssue("timestamps_out_of_order")
        previous_start = pair[0]
    if any(not start <= pair[0] <= pair[1] <= end for pair in timestamps):
        return AlignmentIssue("timestamp_outside_segment_range")
    return None


def timestamps_align(text: str, timestamps: Any, start: int, end: int) -> bool:
    return alignment_issue(text, timestamps, start, end) is None


@dataclass(frozen=True)
class ChunkAlignment:
    """
    Private benchmark diagnostic for one chunk (numbers only, never text): the chunk's text
    tokens against its character timestamps, and each sentence's alignment issue, if any.
    It never changes segments; the transcript only carries the existing review flag.
    """

    text_tokens: int
    timestamps: int | None
    issues: tuple[AlignmentIssue | None, ...]


def chunk_alignment(result: Any) -> ChunkAlignment | None:
    """For output that `normalize_output` accepted. None when there was no speech."""
    item = result[0] if isinstance(result, list) and result else None
    sentences = item.get("sentence_info") if isinstance(item, dict) else None
    if not isinstance(sentences, list) or not sentences:
        return None
    text = item.get("text")  # type: ignore[union-attr]
    timestamps = item.get("timestamp")  # type: ignore[union-attr]
    return ChunkAlignment(
        text_tokens=text_tokens(text) if isinstance(text, str) else 0,
        timestamps=len(timestamps) if isinstance(timestamps, list) else None,
        issues=tuple(
            alignment_issue(
                s["text"],
                s.get("timestamp"),
                _ms(s.get("start"), n, "start"),
                _ms(s.get("end"), n, "end"),
            )
            for n, s in enumerate(sentences, start=1)
        ),
    )


# --- whole text versus sentence text ------------------------------------------------------------

ConsistencyCategory = Literal[
    "consistent",
    "whole_text_has_unmatched_content",
    "sentence_text_has_unmatched_content",
    "content_differs",
]


#: Characters Unicode classes as punctuation that still change meaning ("5%" is not "5").
MEANINGFUL_PUNCTUATION = frozenset("%\u2030\u2031#&@/")


#: Sentence-ending marks never belong to a number, even between two digits ("第2。3…").
SENTENCE_END_MARKS = frozenset("\u3002?!")


def _is_digit(char: str | None) -> bool:
    return char is not None and unicodedata.category(char) == "Nd"


def comparable_text(text: str) -> str:
    """
    Text reduced to what the whole-text/sentence comparison treats as content. Only these
    differences are ignored, in this order:

    1. Unicode NFKC: full-width and half-width forms become one form (full-width A and 1
       become ASCII A and 1);
    2. whitespace (any character for which `str.isspace()` is true);
    3. sentence punctuation: Unicode categories Pc, Pd, Ps, Pe, Pi, Pf and Po, which include
       the full-width Chinese marks — except punctuation that can change what a number or
       word says, which is kept:
       - MEANINGFUL_PUNCTUATION (% ‰ ‱ # & @ /) anywhere;
       - any punctuation directly between two digits ("3.5", "1,000", "1.000", "12:30"),
         except the sentence-ending marks in SENTENCE_END_MARKS (Chinese full stop, ? and !);
       - a dash directly before a digit that doesn't follow a digit (the sign in "-5");
    4. the case of the Latin letters A–Z.

    Everything else is kept: Chinese characters, letters, digits and symbols such as + = ¥
    (Unicode category S). Numbers are not parsed or interpreted: "1,000" and "1000" differ,
    as do "1.000" and "1,000". Whitespace is always ignored, including between digits.
    """
    chars = unicodedata.normalize("NFKC", text)
    kept = []
    for i, char in enumerate(chars):
        if char.isspace():
            continue
        category = unicodedata.category(char)
        if category.startswith("P") and char not in MEANINGFUL_PUNCTUATION:
            before = chars[i - 1] if i > 0 else None
            after = chars[i + 1] if i + 1 < len(chars) else None
            between_digits = (
                _is_digit(before) and _is_digit(after) and char not in SENTENCE_END_MARKS
            )
            sign = category == "Pd" and _is_digit(after) and not _is_digit(before)
            if not (between_digits or sign):
                continue
        kept.append(char.lower() if "A" <= char <= "Z" else char)
    return "".join(kept)


@dataclass(frozen=True)
class TextConsistency:
    """
    How one chunk's whole recognized text compares, in order, with its sentences joined
    together, after `comparable_text`. Lengths and an offset only; never text.

    A mismatch means only that the provider's whole text and its sentence text differ after
    this normalization. It does not show that spoken audio was left out, and Pebble never
    repairs either side.
    """

    category: ConsistencyCategory
    whole_length: int
    sentence_length: int
    #: The first position (in comparable characters) where the two differ; None if they match.
    first_mismatch: int | None

    def __str__(self) -> str:
        return (
            f"text_consistency={self.category} whole_length={self.whole_length} "
            f"sentence_length={self.sentence_length} first_mismatch={self.first_mismatch}"
        )


def _is_subsequence(short: str, long: str) -> bool:
    remaining = iter(long)
    return all(char in remaining for char in short)


def compare_texts(whole: str, sentences: Sequence[str]) -> TextConsistency:
    a = comparable_text(whole)
    b = comparable_text("".join(sentences))
    if a == b:
        return TextConsistency("consistent", len(a), len(b), None)
    first = next(
        (i for i, (x, y) in enumerate(zip(a, b, strict=False)) if x != y), min(len(a), len(b))
    )
    if _is_subsequence(b, a):
        category: ConsistencyCategory = "whole_text_has_unmatched_content"
    elif _is_subsequence(a, b):
        category = "sentence_text_has_unmatched_content"
    else:
        category = "content_differs"
    return TextConsistency(category, len(a), len(b), first)


def text_consistency(result: Any) -> TextConsistency | None:
    """For output that `normalize_output` accepted; None when there were no sentences."""
    item = result[0] if isinstance(result, list) and result else None
    sentences = item.get("sentence_info") if isinstance(item, dict) else None
    if not isinstance(sentences, list) or not sentences:
        return None
    whole = item.get("text")  # type: ignore[union-attr]
    return compare_texts(
        whole if isinstance(whole, str) else "",
        [s["text"] for s in sentences if isinstance(s, dict) and isinstance(s.get("text"), str)],
    )


# --- privacy-safe diagnostics ---------------------------------------------------------------


@dataclass(frozen=True)
class OutputShape:
    results: int
    keys: tuple[str, ...]
    sentences: int | None
    sentence_keys: tuple[str, ...]
    char_timestamps: int | None
    text_chars: int

    def __str__(self) -> str:
        return (
            f"results={self.results} keys={list(self.keys)} sentences={self.sentences} "
            f"sentence_keys={list(self.sentence_keys)} char_timestamps={self.char_timestamps} "
            f"text_chars={self.text_chars}"
        )


def describe_output(result: Any) -> OutputShape:
    """Structure and counts only — never any recognized text."""
    items = result if isinstance(result, list) else []
    first: dict[str, Any] = items[0] if items and isinstance(items[0], dict) else {}
    sentences = first.get("sentence_info")
    sentence_list: Sequence[Any] = sentences if isinstance(sentences, list) else []
    timestamps = first.get("timestamp")
    text = first.get("text")
    return OutputShape(
        results=len(items),
        keys=tuple(sorted(first)),
        sentences=len(sentence_list) if isinstance(sentences, list) else None,
        sentence_keys=tuple(
            sorted({key for s in sentence_list if isinstance(s, dict) for key in s})
        ),
        char_timestamps=len(timestamps) if isinstance(timestamps, list) else None,
        text_chars=len(text) if isinstance(text, str) else 0,
    )
