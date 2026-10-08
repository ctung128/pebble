"""
One speaker run in its own process: `python -m pebble_worker.speakers.child <spec.json>`.

Started only by `runner.run_child`, with a minimal environment and a run-local scratch folder,
inside the OS network sandbox (`isolation.isolated_command`). It proves the denial **before** any
model code is imported; if the proof fails it reports NETWORK_ISOLATION_FAILED and stops. It also
stops if the worker that started it goes away. It writes exactly one JSON file, the spec's
`result` path: `{"result": …}` or `{"error": "<fixed code>"}`. Nothing else is printed, logged or
kept; embeddings never leave this process's memory.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

from . import isolation


def _write(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")
    os.chmod(path, 0o600)


def main(argv: list[str]) -> int:
    spec = json.loads(Path(argv[0]).read_text(encoding="utf-8"))
    result_path = Path(spec["result"])
    # The enforced boundary first (the OS sandbox the parent started us in), then the Python
    # guard as defense in depth. Either missing: stop before any model code is imported.
    if not isolation.os_network_denied():
        _write(result_path, {"error": "NETWORK_ISOLATION_FAILED"})
        return 3
    isolation.deny_network()
    if not isolation.network_denied():
        _write(result_path, {"error": "NETWORK_ISOLATION_FAILED"})
        return 3

    # Only now: anything that could load model code.
    from ..errors import Cancelled
    from ..storage import Storage
    from .campplus import CampplusEmbedder, FunasrClusterer
    from .core import LineSpan, SpeakerRunError, diarize

    storage = Storage(Path(os.environ["PEBBLE_DATA_DIR"]))
    deadline = float(spec["deadlineAt"])
    parent = os.getppid()

    def stop() -> bool:
        # Past the deadline, or the worker that started us is gone (we were re-parented).
        return time.time() >= deadline or os.getppid() != parent

    lines = [
        LineSpan(line["id"], int(line["startMs"]), int(line["endMs"])) for line in spec["lines"]
    ]
    try:
        result = diarize(
            Path(spec["audio"]),
            lines,
            embedder=CampplusEmbedder(storage),
            clusterer=FunasrClusterer(
                Path(spec["numbaCache"]), speaker_count=spec.get("speakerCount")
            ),
            cancel=stop,
        )
    except SpeakerRunError as error:
        _write(result_path, {"error": error.code})
        return 2
    except Cancelled:
        _write(result_path, {"error": "TIMED_OUT"})
        return 2
    except Exception:  # never the exception's text: it could name paths
        _write(result_path, {"error": "CHILD_FAILED"})
        return 1
    _write(
        result_path,
        {
            "result": {
                "assignments": result.assignments,
                "speakers": [
                    {"id": s.id, "lines": s.lines, "windows": s.windows} for s in result.speakers
                ],
                "windows": result.windows,
                "noiseWindows": result.noise_windows,
                "unassignedLines": result.unassigned_lines,
                "clustering": result.clustering,
            }
        },
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
