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

INSTALL_HINT = (
    "Install it in the worker environment: cd services/worker && "
    "UV_CACHE_DIR=~/.pebble/uv-cache uv sync --extra funasr, then restart the worker "
    "(npm run worker:funasr)."
)
PULL_HINT = "Download and verify the models with: npm run worker:models -- pull"

_CJK = re.compile("[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_WORD = re.compile(r"[A-Za-z0-9]+")


class GenerateModel(Protocol):
    def generate(self, *, input: Any, **kwargs: Any) -> Any: ...


Loader = Callable[[Mapping[str, Path]], GenerateModel]
ProviderState = Literal[
    "environment_missing", "models_missing", "verification_failed", "load_failed", "ready"
]


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
        self._lock = threading.Lock()
        self._model: GenerateModel | None = None
        self._verified = False
        self._failure: tuple[ProviderState, str] | None = None

    # --- health -----------------------------------------------------------------------------

    def health(self) -> ProviderHealth:
        """Cheap checks only (no hashing, no imports): safe to call on every /health poll."""
        if self._runtime is None:
            return ProviderHealth(
                False, f"FunASR is not installed. {INSTALL_HINT}", "environment_missing"
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
            return ProviderHealth(
                False,
                f"Speech model files are missing ({missing} of {total}). {PULL_HINT}",
                "models_missing",
            )
        if wrong_size:
            return ProviderHealth(
                False,
                f"{wrong_size} speech model file(s) have the wrong size. Check them with "
                f"npm run worker:models -- verify, then {PULL_HINT[0].lower()}{PULL_HINT[1:]}",
                "verification_failed",
            )
        if self._failure is not None:
            state, detail = self._failure
            return ProviderHealth(False, detail, state)
        if self._model is not None:
            return ProviderHealth(True, "FunASR Paraformer is loaded (CPU).", "ready")
        return ProviderHealth(
            True,
            "FunASR Paraformer is ready (CPU). Models are verified and loaded when the first "
            "transcription starts, which takes a little longer.",
            "ready",
        )

    def provenance_details(self) -> ProvenanceDetails:
        return ProvenanceDetails(
            models=tuple(
                ModelRef(role, spec.model_id, spec.revision) for role, spec in self.models.items()
            ),
            runtime={**(self._runtime or {}), "device": "cpu"},
        )

    # --- transcription ----------------------------------------------------------------------

    def transcribe(self, chunk: AudioChunk, cancel: CancelCheck) -> list[RawSegment]:
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
            return normalize_output(result, chunk.duration_ms)
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
            if not self._verified:
                self._verify_models()
            paths = {role: model_dir(self.storage, spec) for role, spec in self.models.items()}
            try:
                self._model = self._loader(paths)
            except Exception as error:
                log.exception("FunASR failed to load the models")
                detail = (
                    f"FunASR couldn't load the speech models ({type(error).__name__}). "
                    "Check ~/.pebble/logs/worker.log, run npm run worker:models -- verify, "
                    "then restart the worker."
                )
                self._failure = ("load_failed", detail)
                raise PipelineError(
                    FailureCode.PROVIDER_UNAVAILABLE,
                    "FunASR couldn't load the speech models.",
                    hint="Check ~/.pebble/logs/worker.log and run npm run worker:models -- "
                    "verify, then restart the worker and retry.",
                ) from error
            self._failure = None
            log.info("FunASR models loaded (CPU)")
            return self._model

    def _verify_models(self) -> None:
        reports = [verify_model(self.storage, spec) for spec in self.models.values()]
        missing = sum(r.status == "missing" for report in reports for r in report.files)
        failed = sum(r.status == "fail" for report in reports for r in report.files)
        if missing or failed:
            state: ProviderState = "verification_failed" if failed else "models_missing"
            detail = (
                f"Speech model verification failed ({failed} failed, {missing} missing). "
                f"Run npm run worker:models -- verify for details. {PULL_HINT}"
            )
            self._failure = (state, detail)
            raise PipelineError(
                FailureCode.PROVIDER_UNAVAILABLE,
                "The speech model files failed verification, so Pebble won't load them.",
                hint=f"Run npm run worker:models -- verify for details. {PULL_HINT}",
            )
        self._verified = True

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
            if timestamps_align(sentence_text, sentence.get("timestamp"), start, end)
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


def timestamps_align(text: str, timestamps: Any, start: int, end: int) -> bool:
    """
    True when there is nothing to contradict the sentence: no per-character timestamps, or one
    valid `[start, end]` pair, inside the sentence, per token (each CJK character and each run
    of Latin letters/digits). Punctuation and spaces have no timestamp.
    """
    if timestamps is None:
        return True
    if not isinstance(timestamps, list):
        return False
    tokens = len(_CJK.findall(text)) + len(_WORD.findall(text))
    if len(timestamps) != tokens:
        return False
    for pair in timestamps:
        if not (
            isinstance(pair, list | tuple)
            and len(pair) == 2
            and all(isinstance(v, int | float) and not isinstance(v, bool) for v in pair)
        ):
            return False
        if not start <= pair[0] <= pair[1] <= end:
            return False
    return True


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
