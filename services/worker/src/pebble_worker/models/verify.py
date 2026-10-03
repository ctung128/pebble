"""
Checks downloaded model files against the manifest: exact paths only, no globs.

A file passes only if it is a regular file (not a symlink, with no symlink anywhere between it
and the data directory), resolves inside the data directory, and matches the manifest's byte
size and SHA-256.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from ..errors import StorageAccessError
from ..storage import Storage
from .manifest import MODELS_DIRNAME, ModelFile, ModelSpec

FileStatus = Literal["pass", "fail", "missing"]
_CHUNK = 1024 * 1024


@dataclass(frozen=True)
class FileResult:
    file: ModelFile
    path: Path
    status: FileStatus
    actual_size: int | None = None
    actual_sha256: str | None = None
    detail: str | None = None


@dataclass(frozen=True)
class ModelReport:
    spec: ModelSpec
    directory: Path
    files: tuple[FileResult, ...]

    @property
    def passed(self) -> bool:
        return all(result.status == "pass" for result in self.files)


def models_root(storage: Storage) -> Path:
    return storage.root / MODELS_DIRNAME


def model_dir(storage: Storage, spec: ModelSpec) -> Path:
    return models_root(storage).joinpath(*_safe_parts(spec.relative_dir))


def file_path(storage: Storage, spec: ModelSpec, file: ModelFile) -> Path:
    return model_dir(storage, spec).joinpath(*_safe_parts(file.path))


def verify_model(storage: Storage, spec: ModelSpec) -> ModelReport:
    directory = model_dir(storage, spec)
    return ModelReport(
        spec=spec,
        directory=directory,
        files=tuple(verify_file(storage, spec, file) for file in spec.files),
    )


def verify_file(storage: Storage, spec: ModelSpec, file: ModelFile) -> FileResult:
    path = file_path(storage, spec, file)
    symlink = first_symlink(storage, path)
    if symlink is not None:
        return FileResult(file, path, "fail", detail=f"symlink refused: {symlink}")
    try:
        storage.contain(path)
    except StorageAccessError:
        return FileResult(file, path, "fail", detail="outside the Pebble data directory")
    if not path.exists():
        return FileResult(file, path, "missing")
    if not path.is_file():
        return FileResult(file, path, "fail", detail="not a regular file")
    size = path.stat().st_size
    digest = sha256_file(path)
    problems = []
    if size != file.size:
        problems.append("size differs")
    if digest != file.sha256:
        problems.append("SHA-256 differs")
    return FileResult(
        file,
        path,
        "fail" if problems else "pass",
        actual_size=size,
        actual_sha256=digest,
        detail=", ".join(problems) or None,
    )


def first_symlink(storage: Storage, path: Path) -> Path | None:
    """The first symlink between the data directory (exclusive) and `path` (inclusive)."""
    current = path
    while current != storage.root and current != current.parent:
        if current.is_symlink():
            return current
        current = current.parent
    return None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_parts(relative: str) -> tuple[str, ...]:
    """Manifest paths are plain relative POSIX paths; refuse anything else."""
    parts = tuple(relative.split("/"))
    if "\\" in relative or any(part in ("", ".", "..") for part in parts):
        raise StorageAccessError(f"Invalid manifest path: {relative!r}")
    return parts
