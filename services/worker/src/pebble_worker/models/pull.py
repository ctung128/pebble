"""
`pebble-worker models pull`: the only code path that contacts a model hub.

Downloads each manifest entry at its pinned tag into `<data>/models/<owner>/<name>`, fetching
only the manifest's runtime files, then verifies every file. ModelScope's cache and its
settings/telemetry directory are pointed inside the data directory so that removing the data
directory removes everything the download created.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Protocol

from ..storage import PRIVATE_DIR, Storage, make_private
from .manifest import ModelSpec
from .verify import ModelReport, first_symlink, model_dir, models_root, verify_model


class Downloader(Protocol):
    def __call__(
        self, *, model_id: str, revision: str, local_dir: str, allow_patterns: list[str]
    ) -> object: ...


class ModelscopeUnavailable(RuntimeError):
    pass


def hub_environment(storage: Storage) -> dict[str, str]:
    root = models_root(storage)
    return {"MODELSCOPE_CACHE": str(root), "MODELSCOPE_HOME": str(root / ".modelscope")}


def modelscope_downloader(storage: Storage) -> Downloader:
    # Set before modelscope is imported: it reads these when it builds its configuration.
    os.environ.update(hub_environment(storage))
    try:
        from modelscope.hub.snapshot_download import snapshot_download
    except ImportError as error:
        raise ModelscopeUnavailable(
            "ModelScope is not installed in the worker environment. Install the FunASR extra "
            "first: UV_CACHE_DIR=~/.pebble/uv-cache uv sync --extra funasr "
            "(run in services/worker; see docs/MODELS.md)."
        ) from error

    def download(*, model_id: str, revision: str, local_dir: str, allow_patterns: list[str]):
        return snapshot_download(
            model_id=model_id,
            revision=revision,
            local_dir=local_dir,
            allow_patterns=allow_patterns,
        )

    return download


def pull(
    storage: Storage,
    specs: Sequence[ModelSpec],
    downloader: Downloader,
    *,
    report: Callable[[str], None] = print,
) -> list[ModelReport]:
    storage.ensure()
    root = models_root(storage)
    root.mkdir(mode=PRIVATE_DIR, exist_ok=True)
    make_private(root)
    reports = []
    for spec in specs:
        existing = verify_model(storage, spec)
        if existing.passed:
            report(f"{spec.model_id}@{spec.revision}: already present and verified")
            reports.append(existing)
            continue
        directory = model_dir(storage, spec)
        symlink = first_symlink(storage, directory)
        if symlink is not None:
            raise PermissionError(f"Refusing to download through a symlink: {symlink}")
        directory.mkdir(parents=True, mode=PRIVATE_DIR, exist_ok=True)
        report(f"{spec.model_id}@{spec.revision}: downloading {spec.total_size / 1e6:.1f} MB")
        downloader(
            model_id=spec.model_id,
            revision=spec.revision,
            local_dir=str(directory),
            allow_patterns=[file.path for file in spec.files],
        )
        _make_tree_private(directory)
        reports.append(verify_model(storage, spec))
    _make_tree_private(root)
    return reports


def _make_tree_private(directory: Path) -> None:
    if not directory.is_dir() or directory.is_symlink():
        return
    make_private(directory)
    for current, dirs, files in os.walk(directory, followlinks=False):
        for name in (*dirs, *files):
            path = Path(current) / name
            if not path.is_symlink():
                make_private(path)
