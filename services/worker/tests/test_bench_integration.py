"""
Opt-in: `pebble-worker bench` end to end with the real pinned models, on synthetic speech
(invented sentences spoken by macOS `say`), network blocked, in a temporary data directory.

    PEBBLE_FUNASR_INTEGRATION=1 uv run pytest tests/test_bench_integration.py

Model files are APFS-cloned (copy-on-write, no extra space) from the verified models in your
data directory into the temporary one, which is deleted afterwards. The test checks structure
and timing only; recognized text never reaches the console or the results.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from pebble_worker.bench.results import RunResult
from pebble_worker.config import Settings
from pebble_worker.models.verify import model_dir, verify_model
from pebble_worker.providers.funasr import MODELS
from pebble_worker.storage import Storage

CJK = re.compile("[㐀-鿿]")


def _skip_reason() -> str | None:
    if os.environ.get("PEBBLE_FUNASR_INTEGRATION") != "1":
        return "set PEBBLE_FUNASR_INTEGRATION=1 to run the real-model benchmark test"
    if importlib.util.find_spec("funasr") is None:
        return "funasr extra not installed"
    if sys.platform != "darwin" or not shutil.which("say"):
        return "needs macOS `say` for synthetic speech"
    return None


pytestmark = pytest.mark.skipif(_skip_reason() is not None, reason=_skip_reason() or "")


@pytest.fixture
def temp_data_dir(tmp_path):
    real = Storage(Settings.from_env().data_dir)
    if not all(verify_model(real, spec).passed for spec in MODELS.values()):
        pytest.skip("pinned models are missing or fail verification")
    root = tmp_path / "pebble"
    temp = Storage(root)
    temp.ensure()
    for spec in MODELS.values():
        target = model_dir(temp, spec)
        target.parent.mkdir(parents=True, exist_ok=True)
        cloned = subprocess.run(["cp", "-c", "-R", str(model_dir(real, spec)), str(target)])
        if cloned.returncode != 0:
            pytest.skip("APFS cloning unavailable for the temporary directory")
    yield root
    shutil.rmtree(root, ignore_errors=True)
    assert not root.exists()


def _cli(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "PEBBLE_DATA_DIR": str(root)}
    return subprocess.run(
        [sys.executable, "-m", "pebble_worker.cli", "bench", *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=900,
    )


def test_bench_runs_warm_and_cold_on_synthetic_speech(temp_data_dir):
    warm = _cli(temp_data_dir, "run", "--synthetic", "--chunk", "20", "--chunk", "default")
    assert warm.returncode == 0, warm.stderr[-2000:]
    cold = _cli(temp_data_dir, "run", "--synthetic", "--chunk", "default", "--mode", "cold")
    assert cold.returncode == 0, cold.stderr[-2000:]
    report = _cli(temp_data_dir, "report")
    assert report.returncode == 0, report.stderr[-2000:]
    for output in (warm, cold, report):
        assert not CJK.search(output.stdout), "recognized text must never be printed"

    runs = sorted((temp_data_dir / "benchmarks" / "runs").iterdir())
    results = [RunResult.model_validate(json.loads((r / "result.json").read_text())) for r in runs]
    assert sorted((r.mode, r.chunking.is_worker_default) for r in results) == [
        ("cold", True),
        ("warm", False),
        ("warm", True),
    ]
    for result, directory in zip(results, runs, strict=True):
        assert result.status == "completed"
        assert result.network == {"attempts": 0}
        assert result.cer is not None and result.cer.kind == "synthetic-sanity"
        assert result.setup.verification_ms > 0 and result.setup.load_ms > 0
        assert result.job.real_time_factor is not None
        assert result.memory.phys_footprint_job_peak_bytes
        assert not CJK.search((directory / "result.json").read_text())
        assert (directory / "review.md").is_file()
    cold_result = next(r for r in results if r.mode == "cold")
    assert cold_result.setup.scope == "this-run"
    assert cold_result.setup.process_startup_ms is not None
    warm_results = [r for r in results if r.mode == "warm"]
    assert {r.setup.scope for r in warm_results} == {"shared-warm-session"}
    [md] = list((temp_data_dir / "benchmarks" / "reports").glob("report-*.md"))
    assert not CJK.search(md.read_text())
