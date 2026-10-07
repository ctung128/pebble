"""
Pydantic half of the Pebble data contract (packages/schema/CONTRACT.md).

Mirrors the Zod schemas for the payloads the worker produces or consumes — manifest/episode,
transcript, job and worker health — and reports issues with the same codes, paths and
messages, so both sides are tested against the shared examples in packages/schema/examples.
"""

from __future__ import annotations

import re
import unicodedata
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
CURRENT_SCHEMA_VERSION = "1.7"
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
    #: 1.7: the audio's measured length, once known (omitted until then).
    duration_ms: Annotated[int, Field(gt=0)] | None = None
    #: 1.7: transcript lines, once a transcript exists (omitted until then).
    line_count: Annotated[int, Field(ge=0)] | None = None

    _omit_when_none = frozenset({"duration_ms", "line_count"})


# --- Worker health ------------------------------------------------------------------------


class Tool(Model):
    available: bool
    version: NonEmptyStr | None


class Tools(Model):
    ffmpeg: Tool
    ffprobe: Tool


ProviderState = Literal[
    "ready",
    "checking",
    "environment_missing",
    "models_missing",
    "verification_failed",
    "load_failed",
]


class ProviderStatus(Model):
    _omit_when_none = frozenset({"state", "hint"})
    id: NonEmptyStr
    kind: Literal["mock", "asr"]
    available: bool
    detail: NonEmptyStr | None
    state: ProviderState | None = None  # 1.5
    hint: NonEmptyStr | None = None  # 1.5: plain-language remediation for the app


class DataDir(Model):
    path: NonEmptyStr  # abbreviated with "~" under the home directory
    writable: bool
    hint: NonEmptyStr | None


# --- Optional DeepL line translation (1.8; docs/TRANSLATION.md) ----------------------------
#
# None of these shapes carries the API key or a provider's own error text.

TRANSLATION_PROVIDER = "deepl"
TRANSLATION_TARGET_LANGUAGE = "EN-US"
TRANSLATION_CACHE_VERSION = 1
MAX_TRANSLATION_SOURCE_CODE_POINTS = 300
MAX_TRANSLATION_RESULT_CODE_POINTS = 2000

#: Han ideographs that count as "Chinese" (same ranges as lineTranslation.ts).
_HAN_RANGES = (
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xF900, 0xFAFF),
    (0x20000, 0x2FA1F),
    (0x30000, 0x323AF),
)

TRANSLATION_TEXT_MESSAGES = {
    "surrogate": "text must not contain unpaired surrogates",
    "control": "text must not contain control characters",
    "length": f"text must be 1 to {MAX_TRANSLATION_SOURCE_CODE_POINTS} Unicode code points",
    "nfc": "text must be NFC-normalized",
    "chinese": "text must contain a Chinese character",
}


def _is_han(cp: int) -> bool:
    return any(low <= cp <= high for low, high in _HAN_RANGES)


def _is_surrogate(cp: int) -> bool:
    return 0xD800 <= cp <= 0xDFFF


def _is_control(cp: int) -> bool:
    """Unicode general category Cc: C0, DEL and C1."""
    return cp <= 0x1F or 0x7F <= cp <= 0x9F


def translation_text_problem(text: str) -> str | None:
    """
    The first rule a Chinese line breaks, in this order: surrogate, control, length, nfc,
    chinese. None means it may be sent exactly as given (no trimming or other changes).
    """
    cps = [ord(char) for char in text]
    if any(_is_surrogate(cp) for cp in cps):
        return "surrogate"
    if any(_is_control(cp) for cp in cps):
        return "control"
    if not 1 <= len(cps) <= MAX_TRANSLATION_SOURCE_CODE_POINTS:
        return "length"
    if unicodedata.normalize("NFC", text) != text:
        return "nfc"
    if not any(_is_han(cp) for cp in cps):
        return "chinese"
    return None


def _translation_source(value: str) -> str:
    problem = translation_text_problem(value)
    if problem:
        raise ValueError(TRANSLATION_TEXT_MESSAGES[problem])
    return value


def _translated_text(value: str) -> str:
    cps = [ord(char) for char in value]
    if not value.strip():
        raise ValueError("text must not be empty")
    if len(cps) > MAX_TRANSLATION_RESULT_CODE_POINTS:
        raise ValueError(
            f"text must be at most {MAX_TRANSLATION_RESULT_CODE_POINTS} Unicode code points"
        )
    if any(_is_surrogate(cp) for cp in cps):
        raise ValueError("text must not contain unpaired surrogates")
    if any(_is_control(cp) and cp not in (0x09, 0x0A, 0x0D) for cp in cps):
        raise ValueError("text must not contain control characters")
    return value


TranslationSourceText = Annotated[str, AfterValidator(_translation_source)]
TranslatedText = Annotated[str, AfterValidator(_translated_text)]
SourceFingerprint = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
ConsentVersion = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9.-]{0,63}$")]
TranslationProvider = Literal["deepl"]
TargetLanguage = Literal["EN-US"]

#: Fixed error codes for translation routes; messages are fixed copy (TRANSLATION.md).
TranslationErrorCode = Literal[
    "TRANSLATION_OFF",
    "TRANSLATION_CONSENT_REQUIRED",
    "TRANSLATION_LOCAL_LIMIT",
    "TRANSLATION_RATE_LIMITED",
    "TRANSLATION_PROVIDER_QUOTA",
    "TRANSLATION_KEY_REJECTED",
    "TRANSLATION_REQUEST_REJECTED",
    "TRANSLATION_UNAVAILABLE",
    "TRANSLATION_INVALID_TEXT",
    "TRANSLATION_NOT_ALLOWED",
    "EPISODE_NOT_FOUND",
    "SEGMENT_NOT_FOUND",
]


class TranslationLimits(Model):
    period: Annotated[str, Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")]
    requests_used: Annotated[int, Field(ge=0)]
    request_limit: Annotated[int, Field(gt=0)]
    characters_used: Annotated[int, Field(ge=0)]
    character_limit: Annotated[int, Field(gt=0)]


class TranslationHealth(Model):
    """Separate facts: configured, consent, new-request availability. Cache reads need none."""

    provider: TranslationProvider
    configured: bool
    consent: Literal["current", "required", "not_configured"]
    consent_version: ConsentVersion
    new_requests: Literal["available", "consent_required", "local_limit_reached", "off"]
    limits: TranslationLimits


class TranslationRequest(Model):
    schema_version: SchemaVersion
    episode_id: Id
    segment_id: NonEmptyStr
    text: TranslationSourceText


class TranslationResult(Model):
    schema_version: SchemaVersion
    episode_id: Id
    segment_id: NonEmptyStr
    fingerprint: SourceFingerprint
    provider: TranslationProvider
    target_language: TargetLanguage
    text: TranslatedText
    source: Literal["cache", "provider"]
    created_at: IsoDateTime


class CachedTranslation(Model):
    segment_id: NonEmptyStr
    fingerprint: SourceFingerprint
    text: TranslatedText
    created_at: IsoDateTime


class EpisodeTranslations(Model):
    schema_version: SchemaVersion
    episode_id: Id
    provider: TranslationProvider
    target_language: TargetLanguage
    cache_version: Literal[1]
    translations: list[CachedTranslation]


class TranslationConsentRequest(Model):
    schema_version: SchemaVersion
    provider: TranslationProvider
    consent_version: ConsentVersion


class TranslationConsent(Model):
    schema_version: SchemaVersion
    provider: TranslationProvider
    status: Literal["current", "required"]
    consent_version: ConsentVersion
    granted_at: IsoDateTime | None


class WorkerHealth(Model):
    _omit_when_none = frozenset({"data_dir", "instance_id", "translation"})
    schema_version: SchemaVersion
    worker_version: NonEmptyStr
    status: Literal["ok", "degraded"]
    data_dir_writable: bool
    data_dir: DataDir | None = None
    tools: Tools
    providers: list[ProviderStatus]
    #: 1.6: the run nonce of a worker started by `npm run pebble:start` (local lifecycle only).
    instance_id: Annotated[str, Field(pattern=r"^[0-9a-f]{32}$")] | None = None
    #: 1.8: optional DeepL line translation; absent (older workers) means translation is off.
    translation: TranslationHealth | None = None


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


def _health_issues(health: WorkerHealth) -> list[Issue]:
    t = health.translation
    if t is None:
        return []
    at_limit = (
        t.limits.requests_used >= t.limits.request_limit
        or t.limits.characters_used >= t.limits.character_limit
    )
    if not t.configured:
        issues = []
        if t.consent != "not_configured":
            issues.append(
                Issue("translation.consent", "consent must be not_configured when not configured")
            )
        if t.new_requests != "off":
            issues.append(
                Issue("translation.newRequests", "newRequests must be off when not configured")
            )
        return issues
    if t.consent == "not_configured":
        return [Issue("translation.consent", "consent must be current or required when configured")]
    expected = (
        "consent_required"
        if t.consent == "required"
        else "local_limit_reached"
        if at_limit
        else "available"
    )
    if t.new_requests != expected:
        return [Issue("translation.newRequests", f"newRequests must be {expected} here")]
    return []


def _episode_translations_issues(payload: EpisodeTranslations) -> list[Issue]:
    issues: list[Issue] = []
    seen: set[tuple[str, str]] = set()
    for i, row in enumerate(payload.translations):
        key = (row.segment_id, row.fingerprint)
        if key in seen:
            issues.append(
                Issue(
                    f"translations.{i}.fingerprint",
                    "duplicate translation for this segment and fingerprint",
                )
            )
        seen.add(key)
    return issues


def _consent_issues(consent: TranslationConsent) -> list[Issue]:
    if (consent.status == "current") != (consent.granted_at is not None):
        return [Issue("grantedAt", "grantedAt must be set exactly when consent is current")]
    return []


def translation_availability(translation: TranslationHealth | None) -> tuple[bool, str]:
    """(configured, newRequests); an older worker without the field means off."""
    if translation is None:
        return False, "off"
    return translation.configured, translation.new_requests


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
    return _parse(WorkerHealth, payload, "Worker health", _health_issues)


def parse_translation_request(payload: Any) -> ParseResult[TranslationRequest]:
    return _parse(TranslationRequest, payload, "Translation request")


def parse_translation_result(payload: Any) -> ParseResult[TranslationResult]:
    return _parse(TranslationResult, payload, "Translation")


def parse_episode_translations(payload: Any) -> ParseResult[EpisodeTranslations]:
    return _parse(
        EpisodeTranslations, payload, "Episode translations", _episode_translations_issues
    )


def parse_translation_consent_request(payload: Any) -> ParseResult[TranslationConsentRequest]:
    return _parse(TranslationConsentRequest, payload, "Translation consent request")


def parse_translation_consent(payload: Any) -> ParseResult[TranslationConsent]:
    return _parse(TranslationConsent, payload, "Translation consent", _consent_issues)


def require_valid[T](result: ParseResult[T]) -> T:
    """For worker-produced payloads: an invalid result is a bug, never sent to clients."""
    if not result.ok or result.data is None:
        details = "; ".join(f"{i.path}: {i.message}" for i in result.issues)
        raise ValueError(f"{result.message}: {details}")
    return result.data
