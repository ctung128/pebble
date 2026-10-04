"""
A cold benchmark run in a fresh process: `python -m pebble_worker.bench.child '<json>'`.

The spec names a clip id (or "synthetic"), a target and a seed — never a path. Process startup
is measured from the parent's spawn time to this module's first line.
"""

from __future__ import annotations

import time

_STARTED = time.time()

import json  # noqa: E402
import os  # noqa: E402
import sys  # noqa: E402

from ..config import Settings  # noqa: E402
from ..providers.funasr import FunASRProvider  # noqa: E402
from ..storage import Storage  # noqa: E402
from . import network  # noqa: E402
from .corpus import find_clip  # noqa: E402
from .runner import corpus_input, measure_setup, real_import, run_one, synthetic_input  # noqa: E402


def main(argv: list[str]) -> int:
    spec = json.loads(argv[0])
    process_startup_ms = max(0, round((_STARTED - float(spec["spawnedAt"])) * 1000))
    network.block_network()
    os.umask(0o077)
    settings = Settings.from_env()
    storage = Storage(settings.data_dir)
    bench_input = (
        synthetic_input()
        if spec["clip"] == "synthetic"
        else corpus_input(find_clip(storage, spec["clip"]))
    )
    provider = FunASRProvider(storage)
    setup = measure_setup(
        provider,
        import_runtime=real_import,
        scope="this-run",
        process_startup_ms=process_startup_ms,
    )
    directory = run_one(
        storage,
        settings,
        bench_input,
        target_seconds=spec["target"],
        mode="cold",
        provider=provider,
        setup=setup,
        seed=int(spec["seed"]),
    )
    print(json.dumps({"runId": directory.name}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
