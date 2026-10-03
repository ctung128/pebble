"""
FunASR environment proof (M1-A). Run in a fresh interpreter:

    uv run --project services/worker python services/worker/scripts/check_funasr_env.py [stage]

Stages: `funasr` (default), `funasr-without-transformers`, `worker`.

Prints one JSON object. Every socket connection and DNS lookup is blocked and recorded, so the
report also proves that importing FunASR and starting the worker make no network calls. It
downloads nothing and loads no model weights.
"""

from __future__ import annotations

import contextlib
import importlib
import io
import json
import os
import socket
import sys
import tempfile
import time
import types
from pathlib import Path

NETWORK_ATTEMPTS: list[str] = []

#: Modules the selected Paraformer / FSMN-VAD / CT-Punc pipeline needs.
REQUIRED_MODULES = {
    "paraformer": "funasr.models.paraformer.model",
    "seaco_paraformer": "funasr.models.seaco_paraformer.model",
    "fsmn_vad_streaming": "funasr.models.fsmn_vad_streaming.model",
    "ct_transformer": "funasr.models.ct_transformer.model",
    "wav_frontend": "funasr.frontends.wav_frontend",
    "char_tokenizer": "funasr.tokenizer.char_tokenizer",
}
#: Registry entries the three pinned models' config.yaml files name.
REQUIRED_REGISTRY = {
    "model_classes": ["SeacoParaformer", "FsmnVADStreaming", "CTTransformer"],
    "frontend_classes": ["WavFrontend", "WavFrontendOnline"],
    "tokenizer_classes": ["CharTokenizer"],
    "encoder_classes": ["SANMEncoder", "FSMN"],
}
HEAVY = ("funasr", "modelscope", "modelscope_hub", "torch", "torchaudio", "transformers")


def _block_network() -> None:
    def refuse(kind: str):
        def blocked(*args, **kwargs):
            NETWORK_ATTEMPTS.append(f"{kind} {args[1:2] if kind != 'getaddrinfo' else args[:2]}")
            raise OSError("network blocked by check_funasr_env")

        return blocked

    socket.socket.connect = refuse("connect")  # type: ignore[method-assign]
    socket.socket.connect_ex = refuse("connect_ex")  # type: ignore[method-assign]
    socket.getaddrinfo = refuse("getaddrinfo")  # type: ignore[assignment]


def _is_loaded(name: str) -> bool:
    # A module blocked with `sys.modules[name] = None` is present but not loaded.
    return isinstance(sys.modules.get(name), types.ModuleType)


def _loaded(prefixes: tuple[str, ...]) -> list[str]:
    return sorted(name for name in prefixes if _is_loaded(name))


def worker_startup_proof() -> dict:
    """Builds the app, runs its startup, and runs doctor/models list/verify offline."""
    from fastapi.testclient import TestClient

    from pebble_worker.api import create_app
    from pebble_worker.cli import main
    from pebble_worker.config import Settings

    with tempfile.TemporaryDirectory() as tmp:
        settings = Settings(data_dir=Path(tmp) / "pebble")
        app = create_app(settings)
        with TestClient(app, base_url="http://127.0.0.1:8790") as client:
            health = client.get("/health").json()
        with contextlib.redirect_stdout(io.StringIO()):
            os.environ["PEBBLE_DATA_DIR"] = str(Path(tmp) / "pebble")
            codes = {cmd: main(["models", cmd]) for cmd in ("list", "verify")}
    return {
        "heavyModulesLoaded": _loaded(HEAVY),
        "networkAttempts": list(NETWORK_ATTEMPTS),
        "healthProviders": [provider["id"] for provider in health.get("providers", [])],
        "modelsListExit": codes["list"],
        "modelsVerifyExit": codes["verify"],
    }


def funasr_import_proof() -> dict:
    captured = io.StringIO()
    started = time.perf_counter()
    with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
        funasr = importlib.import_module("funasr")
    seconds = round(time.perf_counter() - started, 2)
    from funasr.register import tables

    errors = {name: str(error) for name, error in funasr.get_import_errors().items()}
    required = {}
    for label, module in REQUIRED_MODULES.items():
        related = sorted(name for name in errors if name == module or module.startswith(name))
        required[label] = {
            "module": module,
            "imported": _is_loaded(module),
            "importErrors": related,
        }
    registry = {
        table: {name: name in getattr(tables, table) for name in names}
        for table, names in REQUIRED_REGISTRY.items()
    }
    return {
        "funasrVersion": funasr.__version__,
        "importSeconds": seconds,
        "requiredModules": required,
        "registry": registry,
        "importErrors": errors,
        "transformersLoaded": _is_loaded("transformers"),
        "modelscopeLoaded": _is_loaded("modelscope"),
        "heavyModulesLoaded": _loaded(HEAVY),
        "networkAttempts": list(NETWORK_ATTEMPTS),
        "importOutputLines": [line for line in captured.getvalue().splitlines() if line.strip()],
    }


def main() -> int:
    _block_network()
    stage = sys.argv[1] if len(sys.argv) > 1 else "funasr"
    if stage == "funasr-without-transformers":
        # Diagnostic only: shows the selected models do not depend on transformers, which
        # funasr treats as optional. The worker itself never blocks or patches transformers;
        # in normal use FunASR imports it during package initialization.
        sys.modules["transformers"] = None  # type: ignore[assignment]
    result = worker_startup_proof() if stage == "worker" else funasr_import_proof()
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
