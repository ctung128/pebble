"""
Opt-in real-model test: FunASR on the pinned local models, CPU only, network blocked.

Runs only when all of these hold, and is skipped otherwise:
- PEBBLE_FUNASR_INTEGRATION=1
- the `funasr` extra is installed
- every manifest file in PEBBLE_DATA_DIR (default ~/.pebble) verifies
- macOS `say` with the Tingting voice and FFmpeg are available

    PEBBLE_FUNASR_INTEGRATION=1 uv run pytest tests/test_funasr_integration.py

The audio is synthesized on the fly from an invented sentence; no recording is committed, and
the test asserts structure and timing only, never recognized text.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path

import pytest

from pebble_worker.config import Settings
from pebble_worker.contract import parse_transcript
from pebble_worker.pipeline.merge import ChunkResult, merge
from pebble_worker.pipeline.review import REVIEW_FLAGS
from pebble_worker.providers.base import AudioChunk
from pebble_worker.providers.funasr import MODELS, FunASRProvider
from pebble_worker.storage import Storage

SENTENCES = "今天早上我去市场买了一些水果。然后我在公园里散步，天气很好。"


def _skip_reason() -> str | None:
    if os.environ.get("PEBBLE_FUNASR_INTEGRATION") != "1":
        return "set PEBBLE_FUNASR_INTEGRATION=1 to run the real-model test"
    if importlib.util.find_spec("funasr") is None:
        return "funasr extra not installed"
    if sys.platform != "darwin" or not shutil.which("say") or not shutil.which("ffmpeg"):
        return "needs macOS `say` and ffmpeg to synthesize test speech"
    return None


pytestmark = pytest.mark.skipif(_skip_reason() is not None, reason=_skip_reason() or "")


@pytest.fixture(scope="module")
def storage() -> Storage:
    from pebble_worker.models.verify import verify_model

    storage = Storage(Settings.from_env().data_dir)
    if not all(verify_model(storage, spec).passed for spec in MODELS.values()):
        pytest.skip("pinned models are missing or fail verification (models pull/verify)")
    return storage


@pytest.fixture(scope="module")
def speech(tmp_path_factory) -> AudioChunk:
    root = tmp_path_factory.mktemp("speech")
    aiff, wav = root / "speech.aiff", root / "speech.wav"
    subprocess.run(["say", "-v", "Tingting", "-o", str(aiff), SENTENCES], check=True)
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-i",
            str(aiff),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(wav),
        ],
        check=True,
    )
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(wav)],
        check=True,
        capture_output=True,
        text=True,
    )
    duration_ms = round(float(probe.stdout) * 1000)
    return AudioChunk(0, 0, duration_ms, Path(wav))


@pytest.fixture
def no_network(monkeypatch):
    attempts: list[str] = []

    def refuse(*args, **kwargs):
        attempts.append("network")
        raise OSError("network blocked by test")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "getaddrinfo", refuse)
    return attempts


def test_real_models_produce_valid_sentence_segments_offline(storage, speech, no_network):
    provider = FunASRProvider(storage)
    assert provider.health().state == "checking"  # verification runs in the background
    provider.prepare(wait=True)
    assert provider.health().available

    segments = provider.transcribe(speech, lambda: False)

    assert no_network == []
    assert segments, "expected at least one sentence from clear synthetic speech"
    previous_start = -1
    for segment in segments:
        assert 0 <= segment.start_ms < segment.end_ms <= speech.duration_ms + 500
        assert segment.start_ms >= previous_start
        assert segment.text.strip()
        assert segment.confidence is None and segment.speaker is None
        assert set(segment.review_flags) <= set(REVIEW_FLAGS)
        previous_start = segment.start_ms

    transcript = merge(
        episode_id="ep-0123456789ab",
        duration_ms=speech.duration_ms,
        language="zh-CN",
        chunks=[ChunkResult(0, segments, index=0)],
        provider=provider,
    )
    result = parse_transcript(transcript.dump())
    assert result.ok, result.issues
    provenance = transcript.provenance
    assert provenance.kind == "asr" and provenance.provider == "funasr"
    assert [(m.id, m.revision) for m in provenance.models] == [
        (spec.model_id, spec.revision) for spec in MODELS.values()
    ]
    assert provenance.runtime == {
        "funasr": "1.4.16",
        "torch": "2.11.0",
        "torchaudio": "2.11.0",
        "modelscope": "1.40.1",
        "device": "cpu",
    }
    assert provider.health().state == "ready"
