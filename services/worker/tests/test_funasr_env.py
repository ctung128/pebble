"""
M1-A environment proof, run through scripts/check_funasr_env.py in fresh interpreters with the
network blocked. The worker-startup test always runs; the FunASR tests need the `funasr` extra
(`uv sync --extra funasr`) and are skipped otherwise. No models are loaded or downloaded.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_funasr_env.py"
needs_funasr = pytest.mark.skipif(
    importlib.util.find_spec("funasr") is None, reason="funasr extra not installed"
)


def _proof(stage: str) -> dict:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), stage], capture_output=True, text=True, timeout=300
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_worker_startup_loads_no_speech_stack_and_makes_no_network_calls():
    proof = _proof("worker")
    assert proof["heavyModulesLoaded"] == []
    assert proof["networkAttempts"] == []
    assert proof["healthProviders"] == ["mock"]
    assert proof["modelsListExit"] == 0
    assert proof["modelsVerifyExit"] == 1  # nothing downloaded in the temporary data directory


@pytest.fixture(scope="module")
def funasr_proof() -> dict:
    return _proof("funasr")


@needs_funasr
def test_selected_model_modules_import_without_errors(funasr_proof):
    assert funasr_proof["funasrVersion"] == "1.4.16"
    for label, module in funasr_proof["requiredModules"].items():
        assert module["imported"], label
        assert module["importErrors"] == [], label
    for table, names in funasr_proof["registry"].items():
        assert all(names.values()), table


@needs_funasr
def test_importing_funasr_makes_no_network_calls(funasr_proof):
    assert funasr_proof["networkAttempts"] == []


@needs_funasr
def test_importing_funasr_loads_transformers_as_documented(funasr_proof):
    # docs/MODELS.md: FunASR imports transformers during package initialization because
    # optional FunASR modules use it. If this changes, update the docs.
    assert funasr_proof["transformersLoaded"] is True


@needs_funasr
def test_selected_models_do_not_need_transformers():
    proof = _proof("funasr-without-transformers")
    assert proof["transformersLoaded"] is False
    for module in proof["requiredModules"].values():
        assert module["imported"] and module["importErrors"] == []
    assert all(all(names.values()) for names in proof["registry"].values())
    assert proof["networkAttempts"] == []
