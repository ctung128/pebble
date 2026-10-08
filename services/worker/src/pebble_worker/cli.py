"""`pebble-worker serve`, `doctor`, `check`, `models list|verify|pull [--speaker]` and `bench …`."""

from __future__ import annotations

import argparse
import json
import logging
import os
import platform
import sys
from collections.abc import Sequence

from . import __version__
from .checks import port_state
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
    check = commands.add_parser(
        "check", help="read-only setup check for npm run pebble:doctor (changes nothing)"
    )
    check.add_argument("--json", action="store_true", help="machine-readable output")
    check.add_argument("--verify", action="store_true", help="also hash every model file")
    models = commands.add_parser("models", help="list, verify or download the pinned models")
    models.add_argument("action", choices=("list", "verify", "pull"))
    models.add_argument(
        "--speaker",
        action="store_true",
        help="the optional speaker-embedding model for the diarization evaluation (ADR 0009) "
        "instead of the speech models; transcription never needs it",
    )
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
    if args.command == "check":
        return check_command(settings, as_json=args.json, verify=args.verify)
    if args.command == "doctor":
        return doctor(settings)
    if args.command == "models":
        return models_command(settings, args.action, speaker=args.speaker)
    if args.command == "bench":
        from .bench.commands import run_command as bench_command

        return bench_command(settings, args)
    return run_server(settings)


def run_server(settings: Settings) -> int:
    import uvicorn

    from .api import create_app

    state = port_state(settings.host, settings.port)
    if state == "pebble":
        print(
            f"pebble-worker: a Pebble worker is already running on {settings.host}:"
            f"{settings.port}. Use it, or stop it first (npm run pebble:stop, or Ctrl+C in its "
            "terminal).",
            file=sys.stderr,
        )
        return 2
    if state == "other":
        print(
            f"pebble-worker: port {settings.port} on {settings.host} is already in use by "
            "another program. Pebble won't touch it; choose another port with PEBBLE_PORT "
            "(for example PEBBLE_PORT=8791).",
            file=sys.stderr,
        )
        return 2
    storage = Storage(settings.data_dir)
    storage.ensure()
    _configure_logging(storage)
    if settings.translation.key_missing:
        print(
            "pebble-worker: PEBBLE_TRANSLATION_PROVIDER=deepl is set but DEEPL_AUTH_KEY isn't, "
            "so English translation is off. Transcription works as usual.",
            file=sys.stderr,
        )
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


def models_command(settings: Settings, action: str, *, speaker: bool = False) -> int:
    from .models import commands
    from .models.manifest import MANIFEST, SPEAKER_MODELS

    return commands.run(Storage(settings.data_dir), action, SPEAKER_MODELS if speaker else MANIFEST)


def check_command(settings: Settings, *, as_json: bool, verify: bool) -> int:
    from .checks import run_checks

    result = run_checks(settings, verify=verify)
    if as_json:
        print(json.dumps(result))
        return 0
    models = result["models"]
    rows = [
        ("Python", result["python"]["version"], result["python"]["ok"]),
        ("ffmpeg", result["ffmpeg"]["version"] or "not found", result["ffmpeg"]["ok"]),
        ("ffprobe", result["ffprobe"]["version"] or "not found", result["ffprobe"]["ok"]),
        (
            "Speech packages",
            "installed" if result["environment"]["ok"] else "not installed",
            result["environment"]["ok"],
        ),
        (
            "Speech models",
            f"{models['state']} ({models['present']}/{models['files']} files)",
            models["state"] in ("present", "verified"),
        ),
    ]
    for label, detail, ok in rows:
        print(f"  {'ok ' if ok else 'FAIL'}  {label:<16} {detail}")
    return 0


def _configure_logging(storage: Storage) -> None:
    handler = logging.FileHandler(storage.log_path, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    logging.getLogger("pebble").addHandler(handler)
    logging.getLogger("pebble").setLevel(logging.INFO)


if __name__ == "__main__":
    raise SystemExit(main())
