"""
Pydantic half of the Pebble data contract (packages/schema/CONTRACT.md).

Mirrors the Zod schemas for the payloads the worker produces or consumes — manifest/episode,
transcript, job and worker health — and reports issues with the same codes, paths and
messages, so both sides are tested against the shared examples in packages/schema/examples.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    SerializerFunctionWrapHandler,
    ValidationError,
    model_serializer,
)
from pydantic.alias_generators import to_camel

SUPPORTED_MAJOR = 1
CURRENT_SCHEMA_VERSION = "1.4"
DURATION_TOLERANCE_MS = 500


# --- Field types -------------------------------------------------------------------------


def _schema_version(value: str) -> str:
    if not re.fullmatch(r"1\.\d+", value):
        raise ValueError("expected schemaVersion 1.x")
    return value


def _id(value: str) -> str:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", value):
        raise ValueError("ids are lowercase letters, digits and hyphens")
    return value


_RELATIVE_PATH = re.compile(r"^(?!/)(?![a-z][a-z0-9+.-]*:)(?!.*\.\.)[\w./-]+$", re.IGNORECASE)


def _relative_path(value: str) -> str:
    if not _RELATIVE_PATH.match(value):
        raise ValueError("expected a relative path")
    return value


def _iso_datetime(value: str) -> str:
    try:
        datetime.fromisoformat(value)
    except ValueError as error:
        raise ValueError("expected an ISO 8601 date-time") from error
    return value


def _non_empty(value: str) -> str:
    if not value.strip():
        raise ValueError("text must not be empty")
    return value


def _audio_mime(value: str) -> str:
    if not value.startswith("audio/"):
        raise ValueError("expected an audio/* MIME type")
    return value


SchemaVersion = Annotated[str, AfterValidator(_schema_version)]
Id = Annotated[str, AfterValidator(_id)]
RelativePath = Annotated[str, AfterValidator(_relative_path)]
IsoDateTime = Annotated[str, AfterValidator(_iso_datetime)]
NonEmptyText = Annotated[str, AfterValidator(_non_empty)]
NonEmptyStr = Annotated[str, Field(min_length=1)]
TimeMs = Annotated[int, Field(ge=0)]
DurationMs = Annotated[int, Field(gt=0)]


class Model(BaseModel):
    """camelCase on the wire, strict types (no string-to-number coercion), unknown keys ignored."""

    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, strict=True, extra="ignore"
    )
    #: Optional fields that are omitted (not null) on the wire when unset.
    _omit_when_none: frozenset[str] = frozenset()

    @model_serializer(mode="wrap")
    def _serialize(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        data = handler(self)
        for name in self._omit_when_none:
            key = to_camel(name)
            if data.get(key) is None:
                data.pop(key, None)
        return data

    def dump(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, mode="json")


# --- Manifest / episode ---------------------------------------------------------------------


class AudioProvenance(Model):
    kind: Literal[
        "tts-placeholder", "self-recorded", "licensed", "permission-granted", "user-provided"
    ]
    publishable: bool
    notes: str


class AudioRef(Model):
    src: RelativePath
    mime_type: Annotated[str, AfterValidator(_audio_mime)]


class TranscriptRef(Model):
    src: RelativePath


class DemoRefs(Model):
    _omit_when_none = frozenset({"translations", "illustrative_uncertainty"})
    translations: RelativePath | None = None
    illustrative_uncertainty: RelativePath | None = None


class Episode(Model):
    _omit_when_none = frozenset({"title_zh", "demo"})
    id: Id
    title: NonEmptyText
    title_zh: str | None = None
    description: str
    language: Annotated[str, Field(min_length=2)]
    duration_ms: DurationMs
    audio: AudioRef
    transcript: TranscriptRef
    audio_provenance: AudioProvenance
    demo: DemoRefs | None = None


class Manifest(Model):
    schema_version: SchemaVersion
    episodes: list[Episode]


# --- Transcript ---------------------------------------------------------------------------


class Token(Model):
    text: NonEmptyStr
    start_ms: TimeMs
    end_ms: TimeMs


ReviewFlag = Literal["long_segment", "short_fragment", "timestamp_alignment_anomaly", "speech_gap"]


class SegmentReview(Model):
    flags: list[ReviewFlag]


class Segment(Model):
    _omit_when_none = frozenset({"chunk_index", "review"})
    id: NonEmptyStr
    index: Annotated[int, Field(ge=0)]
    start_ms: TimeMs
    end_ms: TimeMs
    text: NonEmptyText
    speaker: NonEmptyStr | None
    confidence: Annotated[float, Field(ge=0, le=1)] | None
    tokens: list[Token] | None
    chunk_index: Annotated[int, Field(ge=0)] | None = None  # 1.4, worker ASR output
    review: SegmentReview | None = None  # 1.4, structural review metadata; not confidence


class ProvenanceModel(Model):
    role: Literal["asr", "vad", "punctuation"]
    id: NonEmptyStr
    revision: NonEmptyStr


class ReviewThresholds(Model):
    long_segment_ms: Annotated[int, Field(gt=0)]
    short_fragment_ms: Annotated[int, Field(gt=0)]
    speech_gap_ms: Annotated[int, Field(gt=0)]


class ProvenanceReview(Model):
    thresholds: ReviewThresholds


class TranscriptProvenance(Model):
    _omit_when_none = frozenset({"notes", "models", "runtime", "review"})
    kind: Literal["fixture", "asr", "mock"]
    provider: NonEmptyStr
    model: NonEmptyStr | None
    created_at: IsoDateTime
    notes: str | None = None
    models: list[ProvenanceModel] | None = None  # 1.4
    runtime: dict[NonEmptyStr, NonEmptyStr] | None = None  # 1.4
    review: ProvenanceReview | None = None  # 1.4


class Transcript(Model):
    schema_version: SchemaVersion
    episode_id: Id
    language: Annotated[str, Field(min_length=2)]
    script: Literal["simplified", "traditional", "unknown"]
    duration_ms: DurationMs
    segments: list[Segment]
    provenance: TranscriptProvenance


# --- Job ----------------------------------------------------------------------------------

JobStatus = Literal["queued", "running", "completed", "failed", "cancelled"]
JobStage = Literal["probing", "normalizing", "chunking", "transcribing", "merging"]


class JobFailure(Model):
    stage: JobStage | None
    code: Literal[
        "FFMPEG_NOT_FOUND",
        "UNSUPPORTED_MEDIA",
        "NO_AUDIO_STREAM",
        "AUDIO_TOO_LONG",
        "STORAGE_ERROR",
        "PROVIDER_UNAVAILABLE",
        "PROVIDER_ERROR",
        "NO_SPEECH_DETECTED",
        "WORKER_RESTARTED",
        "CANCELLED",
        "INTERNAL_ERROR",
    ]
    message: NonEmptyStr
    retryable: bool
    hint: NonEmptyStr | None


class JobProgress(Model):
    completed_chunks: Annotated[int, Field(ge=0)]
    total_chunks: Annotated[int, Field(gt=0)]


class JobProvider(Model):
    id: NonEmptyStr
    kind: Literal["mock", "asr"]


class Job(Model):
    schema_version: SchemaVersion
    id: NonEmptyStr
    episode_id: Id
    episode_title: NonEmptyText
    status: JobStatus
    stage: JobStage | None
    attempt: Annotated[int, Field(gt=0)]
    progress: JobProgress | None
    failure: JobFailure | None
    provider: JobProvider
    created_at: IsoDateTime
    updated_at: IsoDateTime


# --- Worker health ------------------------------------------------------------------------


class Tool(Model):
    available: bool
    version: NonEmptyStr | None


class Tools(Model):
    ffmpeg: Tool
    ffprobe: Tool


class ProviderStatus(Model):
    id: NonEmptyStr
    kind: Literal["mock", "asr"]
    available: bool
    detail: NonEmptyStr | None


class DataDir(Model):
    path: NonEmptyStr  # abbreviated with "~" under the home directory
    writable: bool
    hint: NonEmptyStr | None


class WorkerHealth(Model):
    _omit_when_none = frozenset({"data_dir"})
    schema_version: SchemaVersion
    worker_version: NonEmptyStr
    status: Literal["ok", "degraded"]
    data_dir_writable: bool
    data_dir: DataDir | None = None
    tools: Tools
    providers: list[ProviderStatus]


# --- Cross-field rules (same paths and messages as the Zod refinements) --------------------


@dataclass(frozen=True)
class Issue:
    path: str
    message: str


def _manifest_issues(manifest: Manifest) -> list[Issue]:
    issues: list[Issue] = []
    seen: set[str] = set()
    for i, episode in enumerate(manifest.episodes):
        if episode.id in seen:
            issues.append(Issue(f"episodes.{i}.id", f'duplicate episode id "{episode.id}"'))
        seen.add(episode.id)
    return issues


def _transcript_issues(transcript: Transcript) -> list[Issue]:
    issues: list[Issue] = []
    seen: set[str] = set()
    for i, segment in enumerate(transcript.segments):
        at = f"segments.{i}"
        if segment.index != i:
            issues.append(Issue(f"{at}.index", f"expected index {i}"))
        if segment.id in seen:
            issues.append(Issue(f"{at}.id", f'duplicate segment id "{segment.id}"'))
        seen.add(segment.id)
        if segment.end_ms <= segment.start_ms:
            issues.append(Issue(f"{at}.endMs", "endMs must be after startMs"))
        if i > 0 and segment.start_ms < transcript.segments[i - 1].start_ms:
            issues.append(Issue(f"{at}.startMs", "segments must be ordered by startMs"))
        if segment.end_ms > transcript.duration_ms + DURATION_TOLERANCE_MS:
            issues.append(Issue(f"{at}.endMs", "segment ends after the transcript duration"))
        for t, token in enumerate(segment.tokens or []):
            if token.end_ms < token.start_ms:
                issues.append(
                    Issue(f"{at}.tokens.{t}.endMs", "token endMs must not be before startMs")
                )
    return issues


def _job_issues(job: Job) -> list[Issue]:
    issues: list[Issue] = []
    if job.progress and job.progress.completed_chunks > job.progress.total_chunks:
        issues.append(
            Issue("progress.completedChunks", "completedChunks must not exceed totalChunks")
        )
    if (job.status in ("failed", "cancelled")) != (job.failure is not None):
        issues.append(
            Issue("failure", "failure must be set exactly when the job failed or was cancelled")
        )
    return issues


# --- Parsing ------------------------------------------------------------------------------


@dataclass
class ParseResult[T]:
    ok: bool
    data: T | None = None
    code: Literal["INVALID_PAYLOAD", "UNSUPPORTED_VERSION"] | None = None
    message: str = ""
    issues: list[Issue] = field(default_factory=list)


def _version_problem(payload: Any) -> str | None:
    found = payload.get("schemaVersion") if isinstance(payload, dict) else None
    if found is None:
        return "missing"
    if not isinstance(found, str):
        return "malformed"
    match = re.fullmatch(r"(\d+)\.(\d+)", found)
    if not match:
        return "malformed"
    return "unsupported" if int(match.group(1)) != SUPPORTED_MAJOR else None


def _parse[T: Model](
    model: type[T], payload: Any, label: str, rules: Callable[[T], list[Issue]] | None = None
) -> ParseResult[T]:
    problem = _version_problem(payload)
    if problem:
        unsupported = problem == "unsupported"
        return ParseResult(
            ok=False,
            code="UNSUPPORTED_VERSION" if unsupported else "INVALID_PAYLOAD",
            message=f"{label} schemaVersion is {problem}",
            issues=[Issue("schemaVersion", problem)],
        )
    try:
        data = model.model_validate(payload)
    except ValidationError as error:
        issues = [Issue(".".join(str(part) for part in e["loc"]), e["msg"]) for e in error.errors()]
        return ParseResult(
            ok=False, code="INVALID_PAYLOAD", message=f"{label} is invalid", issues=issues
        )
    issues = rules(data) if rules else []
    if issues:
        return ParseResult(
            ok=False, code="INVALID_PAYLOAD", message=f"{label} is invalid", issues=issues
        )
    return ParseResult(ok=True, data=data)


def parse_manifest(payload: Any) -> ParseResult[Manifest]:
    return _parse(Manifest, payload, "Manifest", _manifest_issues)


def parse_transcript(payload: Any) -> ParseResult[Transcript]:
    return _parse(Transcript, payload, "Transcript", _transcript_issues)


def parse_job(payload: Any) -> ParseResult[Job]:
    return _parse(Job, payload, "Job", _job_issues)


def parse_worker_health(payload: Any) -> ParseResult[WorkerHealth]:
    return _parse(WorkerHealth, payload, "Worker health")


def require_valid[T](result: ParseResult[T]) -> T:
    """For worker-produced payloads: an invalid result is a bug, never sent to clients."""
    if not result.ok or result.data is None:
        details = "; ".join(f"{i.path}: {i.message}" for i in result.issues)
        raise ValueError(f"{result.message}: {details}")
    return result.data
