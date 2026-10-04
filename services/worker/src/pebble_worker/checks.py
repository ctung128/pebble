"""
Read-only setup checks for `npm run pebble:doctor` (`pebble-worker check`).

Unlike `pebble-worker doctor`, this never creates the data folder, migrates the database,
installs packages, downloads models, starts a worker or touches the network. The quick check
compares model files with the manifest's sizes; `--verify` also hashes every file (SHA-256).
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import socket
import sys
import urllib.error
import urllib.request
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Literal

from .config import Settings
from .contract import parse_worker_health
from .health import display_path
from .models.manifest import MANIFEST, ModelSpec
from .models.verify import file_path, first_symlink, verify_model
from .pipeline.tools import tool_version
from .providers.funasr import installed_runtime
from .storage import Storage

ModelState = Literal["missing", "incomplete", "wrong_size", "present", "verified", "failed"]


def run_checks(
    settings: Settings, *, verify: bool = False, specs: Sequence[ModelSpec] = MANIFEST
) -> dict[str, Any]:
    storage = Storage(settings.data_dir)
    runtime = installed_runtime()
    return {
        "python": {
            "version": platform.python_version(),
            "ok": sys.version_info >= (3, 12),
        },
        "ffmpeg": _tool(settings.ffmpeg_path),
        "ffprobe": _tool(settings.ffprobe_path),
        "dataDir": _data_dir(storage.root),
        "environment": {"ok": runtime is not None, "runtime": runtime},
        "models": _models(storage, specs, verify=verify),
        "disk": {"freeBytes": shutil.disk_usage(_existing_ancestor(storage.root)).free},
    }


def _tool(binary: str) -> dict[str, Any]:
    version = tool_version(binary)
    return {"ok": version is not None, "version": version}


def _existing_ancestor(path: Path) -> Path:
    while not path.exists() and path != path.parent:
        path = path.parent
    return path


def _data_dir(root: Path) -> dict[str, Any]:
    exists = root.is_dir()
    target = root if exists else _existing_ancestor(root)
    return {
        "path": display_path(root),
        "exists": exists,
        "private": (root.stat().st_mode & 0o077) == 0 if exists else None,
        "writable": os.access(target, os.W_OK),
    }


def _models(storage: Storage, specs: Sequence[ModelSpec], *, verify: bool) -> dict[str, Any]:
    files = [(spec, f) for spec in specs for f in spec.files]
    required = sum(f.size for _, f in files)
    present = missing = wrong_size = 0
    present_bytes = 0
    for spec, f in files:
        path = file_path(storage, spec, f)
        if not path.is_file() or first_symlink(storage, path) is not None:
            missing += 1
        elif path.stat().st_size != f.size:
            wrong_size += 1
        else:
            present += 1
            present_bytes += f.size
    state: ModelState
    if present == 0 and wrong_size == 0:
        state = "missing"
    elif missing:
        state = "incomplete"
    elif wrong_size:
        state = "wrong_size"
    else:
        state = "present"
    verified: bool | None = None
    if verify and state == "present":
        verified = all(verify_model(storage, spec).passed for spec in specs)
        state = "verified" if verified else "failed"
    return {
        "state": state,
        "files": len(files),
        "present": present,
        "missing": missing,
        "wrongSize": wrong_size,
        "requiredBytes": required,
        "presentBytes": present_bytes,
        "verified": verified,
        "location": display_path(storage.root / "models"),
    }


# --- the worker's own port pre-check -------------------------------------------------------

PortState = Literal["free", "pebble", "other"]


def port_state(host: str, port: int) -> PortState:
    """
    `free` only when nothing accepts a connection *and* the port can be bound the way the
    server binds it (with SO_REUSEADDR, so connections left over from a previous run don't
    count). Accepting a connection covers programs listening on every address, which a
    loopback bind with SO_REUSEADDR can't detect on macOS.
    """
    try:
        with socket.create_connection((host, port), timeout=0.5):
            accepting = True
    except OSError:
        accepting = False
    if accepting:
        return "pebble" if _is_pebble(host, port) else "other"
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((host, port))
        except OSError:
            return "other"
    return "free"


def _is_pebble(host: str, port: int) -> bool:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # never via a proxy
    try:
        with opener.open(f"http://{host}:{port}/health", timeout=1) as response:
            return parse_worker_health(json.loads(response.read())).ok
    except (OSError, ValueError, urllib.error.URLError):
        return False
