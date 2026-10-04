"""
The private per-run result schema (`<run>/result.json`). Numbers, labels and model metadata
only: no recognized text, no source paths, no episode ids.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

RESULT_SCHEMA_VERSION = 1

Ms = Annotated[int, Field(ge=0)]


class _Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

    def dump(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, mode="json")


class ClipInfo(_Model):
    id: str
    label: str
    kind: Literal["corpus", "synthetic"]
    duration_ms: Ms | None


class Chunking(_Model):
    target_seconds: float
    min_seconds: float
    max_seconds: float
    silence_min_seconds: float
    silence_noise_db: float
    is_worker_default: bool


class SetupTiming(_Model):
    scope: Literal["this-run", "shared-warm-session"]
    process_startup_ms: Ms | None
    verification_ms: Ms
    import_ms: Ms
    load_ms: Ms


class JobTiming(_Model):
    probe_ms: Ms | None
    normalize_ms: Ms | None
    chunking_ms: Ms | None
    transcription_ms: Ms | None
    merge_ms: Ms | None
    total_ms: Ms
    real_time_factor: float | None


class Memory(_Model):
    method: str
    phys_footprint_job_peak_bytes: int | None
    phys_footprint_lifetime_peak_bytes: int | None
    rss_max_bytes: int


class Cer(_Model):
    value: float | None
    kind: Literal["reference", "synthetic-sanity"]
    reference_label: str | None


class Failure(_Model):
    stage: str
    code: str


class RunResult(_Model):
    schema_version: Literal[1]
    run_id: str
    created_at: str
    worker_version: str
    status: Literal["completed", "no-speech", "failed"]
    failure: Failure | None
    clip: ClipInfo
    mode: Literal["warm", "cold"]
    chunking: Chunking
    provider: dict[str, Any]
    setup: SetupTiming
    job: JobTiming
    memory: Memory
    chunks: dict[str, Any]
    segments: dict[str, Any] | None
    merge: dict[str, Any] | None
    boundaries: dict[str, Any] | None
    #: The private alignment diagnostic (numbers only); absent from runs before it existed.
    alignment: dict[str, Any] | None = None
    cer: Cer | None
    review: dict[str, Any] | None
    network: dict[str, int]
