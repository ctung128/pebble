"""
A diarization evaluation run in its own process (started by `diarize.run_bounded`):
`python -m pebble_worker.bench.diarize_child '<json>'`. The spec names an episode id and a run
id, never a path. Prints only the run id or an error code.
"""

from __future__ import annotations

import json
import os
import sys

from ..config import Settings
from ..storage import Storage
from . import network
from .diarize import DiarizeError, run


def main(argv: list[str]) -> int:
    spec = json.loads(argv[0])
    network.block_network()
    os.umask(0o077)
    settings = Settings.from_env()
    storage = Storage(settings.data_dir)
    try:
        directory = run(
            storage,
            settings,
            spec["episode"],
            hint=spec["hint"],
            lines=int(spec["lines"]),
            seed=int(spec["seed"]),
            run_id=spec["runId"],
            deadline_at=float(spec["deadlineAt"]),
        )
    except DiarizeError as error:
        print(json.dumps({"error": type(error).__name__}))
        return 2
    except Exception as error:  # run() has already cleaned up and recorded the failure
        print(json.dumps({"error": type(error).__name__}))
        return 1
    print(json.dumps({"runId": directory.name}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
