"""`pebble-worker serve`, `doctor`, `models list|verify|pull` and `bench run|report|review`."""

from __future__ import annotations

import argparse
import logging
import os
import platform
import socket
import sys
from collections.abc import Sequence

from . import __version__
from .config import Settings
from .db import MIGRATIONS, Database
from .errors import ConfigError
from .pipeline.tools import tool_version
from .providers.factory import build_provider
from .storage import Storage


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pebble-worker", description="Pebble local worker")
    commands = parser.add_subparsers(dest="command", required=True)
    serve = commands.add_parser("serve", help="run the worker on 127.0.0.1")
    serve.add_argument("--host", help="must be 127.0.0.1 (anything else is refused)")
    serve.add_argument("--port", type=int)
    commands.add_parser("doctor", help="check FFmpeg, the data directory and providers")
    models = commands.add_parser("models", help="list, verify or download the pinned models")
    models.add_argument("action", choices=("list", "verify", "pull"))
    from .bench.commands import add_parser as add_bench_parser

    add_bench_parser(commands)
    args = parser.parse_args(argv)

    overrides: dict[str, object] = {}
    if getattr(args, "host", None):
        overrides["host"] = args.host
    if getattr(args, "port", None):
        overrides["port"] = args.port
    try:
        settings = Settings.from_env(**overrides)
    except ConfigError as error:
        print(f"pebble-worker: {error}", file=sys.stderr)
        return 2

    os.umask(0o077)  # everything the worker creates is private to this user
    if args.command == "doctor":
        return doctor(settings)
    if args.command == "models":
        return models_command(settings, args.action)
    if args.command == "bench":
        from .bench.commands import run_command as bench_command

        return bench_command(settings, args)
    return run_server(settings)


def run_server(settings: Settings) -> int:
    import uvicorn

    from .api import create_app

    if not _port_available(settings.host, settings.port):
        print(
            f"pebble-worker: port {settings.port} on {settings.host} is already in use by "
            "another program. Stop it, or choose another port with PEBBLE_PORT.",
            file=sys.stderr,
        )
        return 2
    storage = Storage(settings.data_dir)
    storage.ensure()
    _configure_logging(storage)
    app = create_app(settings)
    print(f"Pebble worker {__version__} on http://{settings.host}:{settings.port}")
    print(f"Data directory: {storage.root}")
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_level="info",
        server_header=False,
        proxy_headers=False,
    )
    return 0


def doctor(settings: Settings) -> int:
    storage = Storage(settings.data_dir)
    rows: list[tuple[str, str, bool]] = []

    rows.append(("Python", platform.python_version(), sys.version_info >= (3, 12)))
    for name, binary in (("ffmpeg", settings.ffmpeg_path), ("ffprobe", settings.ffprobe_path)):
        version = tool_version(binary)
        rows.append((name, version or "not found — install FFmpeg", version is not None))

    try:
        storage.ensure()
        private = (storage.root.stat().st_mode & 0o077) == 0
        writable = os.access(storage.root, os.W_OK)
        detail = (
            f"{storage.root} ({'private' if private else 'NOT private'}, "
            f"{'writable' if writable else 'NOT writable'})"
        )
        rows.append(("Data directory", detail, private and writable))
        version = Database(storage.db_path).migrate()
        rows.append(("Database", f"schema v{version} of {len(MIGRATIONS)}", True))
    except OSError as error:
        rows.append(("Data directory", f"{storage.root}: {error}", False))

    provider = build_provider(settings, storage)
    provider.prepare(wait=True)  # doctor waits for full model verification
    health = provider.health()
    rows.append(("Provider", f"{provider.id} — {health.detail}", health.available))
    rows.append(("Binding", f"{settings.host}:{settings.port} (loopback only)", True))
    rows.append(("Allowed origins", ", ".join(settings.allowed_origins), True))
    chunking = settings.chunking
    rows.append(
        (
            "Chunking",
            f"target {chunking.target_seconds:g}s, "
            f"range {chunking.min_seconds:g}–{chunking.max_seconds:g}s",
            True,
        )
    )

    print(f"Pebble worker {__version__} — doctor")
    for label, detail, ok in rows:
        print(f"  {'ok ' if ok else 'FAIL'}  {label:<16} {detail}")
    healthy = all(ok for _, _, ok in rows)
    print("All checks passed." if healthy else "Some checks failed.")
    return 0 if healthy else 1


def models_command(settings: Settings, action: str) -> int:
    from .models import commands

    return commands.run(Storage(settings.data_dir), action)


def _port_available(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind((host, port))
        except OSError:
            return False
    return True


def _configure_logging(storage: Storage) -> None:
    handler = logging.FileHandler(storage.log_path, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    logging.getLogger("pebble").addHandler(handler)
    logging.getLogger("pebble").setLevel(logging.INFO)


if __name__ == "__main__":
    raise SystemExit(main())
