"""
The private benchmark corpus manifest: `<data>/benchmarks/corpus.json`, written by hand.

It holds only what the benchmark needs — local path, neutral label, duration, the owner's
rights note, and optionally a reference-transcript path and difficulty notes. It is never
committed, copied into reports or docs, printed, or served.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..storage import Storage
from .paths import corpus_path

CLIP_ID = re.compile(r"^clip-[a-z0-9]{1,12}$")
#: The repository root (…/services/worker/src/pebble_worker/bench → repo).
REPO_ROOT = Path(__file__).resolve().parents[5]


class CorpusError(ValueError):
    pass


class _Clip(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)

    id: str
    label: Annotated[str, Field(min_length=1, max_length=40)]
    path: Annotated[str, Field(min_length=1)]
    duration_seconds: Annotated[float, Field(gt=0, alias="durationSeconds")]
    rights_note: Annotated[str, Field(min_length=1, alias="rightsNote")]
    reference_path: Annotated[str | None, Field(alias="referencePath")] = None
    difficulty_notes: Annotated[str | None, Field(alias="difficultyNotes")] = None


class _Corpus(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)

    schema_version: Annotated[int, Field(alias="schemaVersion")]
    clips: list[_Clip]


@dataclass(frozen=True)
class Clip:
    id: str
    label: str
    path: Path
    duration_seconds: float
    reference_path: Path | None


def load_corpus(storage: Storage) -> list[Clip]:
    path = corpus_path(storage)
    if not path.is_file():
        raise CorpusError(
            "No benchmark corpus yet. Create ~/.pebble/benchmarks/corpus.json as described in "
            "docs/BENCHMARKS.md."
        )
    try:
        parsed = _Corpus.model_validate(json.loads(path.read_text(encoding="utf-8")))
    except (json.JSONDecodeError, ValidationError) as error:
        raise CorpusError(f"corpus.json is invalid: {_summary(error)}") from None
    if parsed.schema_version != 1:
        raise CorpusError("corpus.json must have schemaVersion 1.")
    clips = [_check(clip) for clip in parsed.clips]
    ids = [clip.id for clip in clips]
    if len(ids) != len(set(ids)):
        raise CorpusError("Clip ids in corpus.json must be unique.")
    return clips


def find_clip(storage: Storage, clip_id: str) -> Clip:
    for clip in load_corpus(storage):
        if clip.id == clip_id:
            return clip
    raise CorpusError(f"No clip {clip_id!r} in corpus.json.")


def _check(clip: _Clip) -> Clip:
    # Messages name the clip id only, never its path or notes.
    if not CLIP_ID.match(clip.id):
        raise CorpusError(f"Clip id {clip.id!r} must look like clip-a, clip-b, …")
    if not clip.rights_note.strip():
        raise CorpusError(f"{clip.id}: rightsNote is required.")
    audio = _existing_file(Path(clip.path), clip.id, "path")
    reference = (
        _existing_file(Path(clip.reference_path), clip.id, "referencePath")
        if clip.reference_path
        else None
    )
    return Clip(clip.id, clip.label, audio, clip.duration_seconds, reference)


def _existing_file(path: Path, clip_id: str, field: str) -> Path:
    if not path.is_absolute():
        raise CorpusError(f"{clip_id}: {field} must be an absolute path.")
    resolved = path.resolve()
    if not resolved.is_file():
        raise CorpusError(f"{clip_id}: {field} is not a readable file.")
    if (REPO_ROOT / ".git").exists() and resolved.is_relative_to(REPO_ROOT):
        raise CorpusError(
            f"{clip_id}: {field} is inside the Pebble repository. Keep benchmark audio and "
            "reference text outside it so they can never be committed."
        )
    return resolved


def _summary(error: Exception) -> str:
    if isinstance(error, ValidationError):
        return "; ".join(
            f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in error.errors()
        )
    return type(error).__name__
