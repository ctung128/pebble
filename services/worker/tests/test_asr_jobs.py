"""Whole jobs with the FunASR provider and a fake AutoModel (no FunASR, torch or weights)."""

from __future__ import annotations

import json

import pytest
from conftest import upload, wait_for_job
from test_funasr_provider import RUNTIME, SPECS, install_models

from pebble_worker.config import Settings
from pebble_worker.contract import CURRENT_SCHEMA_VERSION, parse_transcript
from pebble_worker.errors import ConfigError
from pebble_worker.providers.factory import build_provider
from pebble_worker.providers.funasr import FunASRProvider
from pebble_worker.storage import Storage

SAMPLES_PER_MS = 16


class SentencePerChunk:
    """Fake AutoModel: one invented sentence per chunk, 100 ms in from each edge."""

    def generate(self, *, input, **kwargs):
        duration = len(input) // SAMPLES_PER_MS
        text = "这是一句测试。"
        return [
            {
                "key": "chunk",
                "text": text,
                "timestamp": [],
                "sentence_info": [{"text": text, "start": 100, "end": duration - 100}],
            }
        ]


class Silence:
    def generate(self, *, input, **kwargs):
        return [{"key": "chunk", "text": "", "timestamp": []}]


def funasr(settings, model, *, install=True):
    storage = Storage(settings.data_dir)
    storage.ensure()
    if install:
        install_models(storage)
    return FunASRProvider(
        storage,
        loader=lambda paths: model,
        runtime=lambda: RUNTIME,
        reader=lambda chunk: [0.0] * (chunk.duration_ms * SAMPLES_PER_MS),
        models=SPECS,
    )


def transcript_body(client, episode_id):
    with client.app.state.db.tx() as conn:
        row = conn.execute(
            "SELECT body FROM transcripts WHERE episode_id = ?", (episode_id,)
        ).fetchone()
    return None if row is None else json.loads(row["body"])


def test_asr_job_produces_sentence_segments_with_provenance(make_client, settings, audio):
    client = make_client(provider=funasr(settings, SentencePerChunk()))
    job = upload(client, audio["tone_gaps"])["body"]["job"]
    done = wait_for_job(client, job["id"])
    assert done["status"] == "completed", done["failure"]
    assert done["provider"] == {"id": "funasr", "kind": "asr"}

    body = transcript_body(client, job["episodeId"])
    result = parse_transcript(body)
    assert result.ok, result.issues
    transcript = result.data
    assert transcript.provenance.kind == "asr"
    assert [m.role for m in transcript.provenance.models] == ["asr", "vad", "punctuation"]
    assert [s.chunk_index for s in transcript.segments] == list(range(6))
    assert all(s.confidence is None and s.tokens is None for s in transcript.segments)
    assert all(s.review is not None for s in transcript.segments)
    for segment in transcript.segments:
        assert 0 <= segment.start_ms < segment.end_ms <= transcript.duration_ms


def test_no_speech_anywhere_fails_clearly_instead_of_an_empty_transcript(
    make_client, settings, audio
):
    client = make_client(provider=funasr(settings, Silence()))
    job = upload(client, audio["tone_gaps"])["body"]["job"]
    done = wait_for_job(client, job["id"])
    assert done["status"] == "failed"
    failure = done["failure"]
    assert (failure["code"], failure["stage"], failure["retryable"]) == (
        "NO_SPEECH_DETECTED",
        "merging",
        False,
    )
    assert "didn't find any speech" in failure["message"]
    assert transcript_body(client, job["episodeId"]) is None


def test_missing_models_fail_the_job_and_never_fall_back_to_mock(make_client, settings, audio):
    client = make_client(provider=funasr(settings, SentencePerChunk(), install=False))
    health = client.get("/health").json()
    assert health["status"] == "degraded"
    assert health["providers"][0]["id"] == "funasr"
    assert health["providers"][0]["available"] is False

    job = upload(client, audio["short"])["body"]["job"]
    done = wait_for_job(client, job["id"])
    assert done["status"] == "failed"
    assert done["provider"] == {"id": "funasr", "kind": "asr"}
    assert (done["failure"]["code"], done["failure"]["stage"]) == (
        "PROVIDER_UNAVAILABLE",
        "transcribing",
    )
    assert transcript_body(client, job["episodeId"]) is None


def test_mock_transcripts_carry_no_asr_metadata(client, audio):
    job = upload(client, audio["short"])["body"]["job"]
    wait_for_job(client, job["id"])
    body = transcript_body(client, job["episodeId"])
    assert body["provenance"]["kind"] == "mock"
    assert not {"models", "runtime", "review"} & set(body["provenance"])
    assert not {"chunkIndex", "review"} & set(body["segments"][0])


# --- selection --------------------------------------------------------------------------------


def test_provider_is_selected_explicitly(tmp_path):
    storage = Storage(tmp_path / "pebble")
    default = Settings.from_env({"PEBBLE_DATA_DIR": str(tmp_path / "pebble")})
    assert build_provider(default, storage).id == "mock"
    chosen = Settings.from_env(
        {"PEBBLE_DATA_DIR": str(tmp_path / "pebble"), "PEBBLE_PROVIDER": "FunASR"}
    )
    assert isinstance(build_provider(chosen, storage), FunASRProvider)


@pytest.mark.parametrize("name", ["whisper", "cloud", "funasr-mps"])
def test_unknown_providers_are_refused(tmp_path, name):
    with pytest.raises(ConfigError, match="Unknown provider"):
        Settings.from_env({"PEBBLE_DATA_DIR": str(tmp_path), "PEBBLE_PROVIDER": name})


def test_review_thresholds_come_from_the_environment(tmp_path):
    settings = Settings.from_env(
        {"PEBBLE_DATA_DIR": str(tmp_path), "PEBBLE_REVIEW_SPEECH_GAP_MS": "3500"}
    )
    assert settings.review.speech_gap_ms == 3500
    with pytest.raises(ConfigError):
        Settings.from_env({"PEBBLE_DATA_DIR": str(tmp_path), "PEBBLE_REVIEW_LONG_SEGMENT_MS": "0"})


# --- /health (schema 1.5) -----------------------------------------------------------------------


def _provider_status(client):
    body = client.get("/health").json()
    assert body["schemaVersion"] == CURRENT_SCHEMA_VERSION
    [provider] = body["providers"]
    return body["status"], provider


def test_health_reports_checking_then_ready_for_funasr(make_client, settings):
    provider = funasr(settings, SentencePerChunk())
    client = make_client(provider=provider)  # startup begins verification in the background
    provider.prepare(wait=True)
    status, entry = _provider_status(client)
    assert (status, entry["id"], entry["kind"], entry["state"], entry["available"]) == (
        "ok",
        "funasr",
        "asr",
        "ready",
        True,
    )
    assert "hint" not in entry


def test_health_reports_setup_state_and_hint_for_funasr(make_client, settings):
    client = make_client(provider=funasr(settings, SentencePerChunk(), install=False))
    status, entry = _provider_status(client)
    assert (status, entry["state"], entry["available"]) == ("degraded", "models_missing", False)
    assert entry["hint"].endswith("npm run pebble:setup")


def test_mock_health_reports_ready_without_a_hint(client):
    status, entry = _provider_status(client)
    assert (status, entry["id"], entry["state"], entry["available"]) == (
        "ok",
        "mock",
        "ready",
        True,
    )
    assert "hint" not in entry
