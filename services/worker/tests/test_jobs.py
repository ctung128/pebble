"""Job state machine: success, structured failure, conservative retry, cancel, restart."""

from __future__ import annotations

import json
import sqlite3

import pytest
from conftest import upload, wait_for_job

from pebble_worker.contract import parse_transcript
from pebble_worker.providers.mock import MockProvider


def chunk_rows(client, job_id):
    with client.app.state.db.tx() as conn:
        return [
            dict(r)
            for r in conn.execute(
                "SELECT attempt, idx, status, cut FROM chunks"
                " WHERE job_id = ? ORDER BY attempt, idx",
                (job_id,),
            )
        ]


def transcript_row(client, episode_id):
    with client.app.state.db.tx() as conn:
        return conn.execute(
            "SELECT * FROM transcripts WHERE episode_id = ?", (episode_id,)
        ).fetchone()


def test_successful_job_reports_true_progress_and_stores_a_mock_transcript(client, audio):
    created = upload(client, audio["tone_gaps"])
    assert created["status"] == 201
    job = created["body"]["job"]
    assert (job["status"], job["stage"], job["attempt"], job["progress"]) == (
        "queued",
        None,
        1,
        None,
    )

    done = wait_for_job(client, job["id"])
    assert done["status"] == "completed"
    assert done["failure"] is None
    assert done["progress"] == {"completedChunks": 6, "totalChunks": 6}
    assert done["provider"] == {"id": "mock", "kind": "mock"}

    rows = chunk_rows(client, job["id"])
    assert [r["status"] for r in rows] == ["done"] * 6
    assert [r["cut"] for r in rows] == ["silence"] * 5 + ["end"]

    body = json.loads(transcript_row(client, job["episodeId"])["body"])
    result = parse_transcript(body)
    assert result.ok
    transcript = result.data
    assert transcript.provenance.kind == "mock"
    assert "not a transcription" in transcript.provenance.notes
    assert all(s.confidence is None for s in transcript.segments)
    assert transcript.segments[-1].end_ms <= transcript.duration_ms


def test_unsupported_media_fails_without_retry(client, audio):
    job = upload(client, audio["not_audio"])["body"]["job"]
    done = wait_for_job(client, job["id"])
    assert done["status"] == "failed"
    assert done["failure"] == {
        "stage": "probing",
        "code": "UNSUPPORTED_MEDIA",
        "message": "This file couldn't be read as audio.",
        "retryable": False,
        "hint": "Use a common audio format such as M4A, MP3, WAV, FLAC or OGG.",
    }
    response = client.post(f"/jobs/{job['id']}/retry")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "JOB_NOT_RETRYABLE"


def test_provider_failure_never_merges_partial_output_and_retry_restarts_safely(
    make_client, settings, audio
):
    provider = MockProvider(delay_ms=0, fail_at_chunk=3)
    client = make_client(provider=provider)
    job = upload(client, audio["tone_gaps"])["body"]["job"]

    failed = wait_for_job(client, job["id"])
    assert failed["status"] == "failed"
    assert failed["stage"] == "transcribing"
    assert failed["failure"]["code"] == "PROVIDER_ERROR"
    assert failed["failure"]["retryable"] is True
    assert failed["progress"] == {"completedChunks": 2, "totalChunks": 6}  # honest progress
    assert transcript_row(client, job["episodeId"]) is None  # nothing partial was merged
    assert client.get(f"/episodes/{job['episodeId']}/transcript").status_code == 409

    provider.fail_at_chunk = None
    retried = client.post(f"/jobs/{job['id']}/retry").json()
    assert (retried["status"], retried["attempt"], retried["progress"], retried["failure"]) == (
        "queued",
        2,
        None,
        None,
    )

    done = wait_for_job(client, job["id"])
    assert done["status"] == "completed"
    assert done["progress"] == {"completedChunks": 6, "totalChunks": 6}

    rows = chunk_rows(client, job["id"])
    first = [r["status"] for r in rows if r["attempt"] == 1]
    second = [r["status"] for r in rows if r["attempt"] == 2]
    assert first == ["done", "done", "failed", "failed", "failed", "failed"]  # kept, not reused
    assert second == ["done"] * 6
    assert transcript_row(client, job["episodeId"])["attempt"] == 2


class CancelAfterFirstChunk(MockProvider):
    """Requests cancellation through the service once the first chunk is done."""

    def __init__(self, service_ref):
        super().__init__(delay_ms=0)
        self.service_ref = service_ref

    def transcribe(self, chunk, cancel):
        segments = super().transcribe(chunk, cancel)
        if chunk.index == 0:
            service = self.service_ref()
            job_id = service.list()[0].id
            service.request_cancel(job_id)
        return segments


def test_cancel_stops_at_the_next_checkpoint_and_can_be_retried(make_client, audio):
    holder = {}
    client = make_client(provider=CancelAfterFirstChunk(lambda: holder["service"]))
    holder["service"] = client.app.state.service
    job = upload(client, audio["tone_gaps"])["body"]["job"]

    cancelled = wait_for_job(client, job["id"])
    assert cancelled["status"] == "cancelled"
    assert cancelled["failure"]["code"] == "CANCELLED"
    assert cancelled["failure"]["stage"] == "transcribing"
    assert cancelled["failure"]["retryable"] is True
    assert cancelled["progress"]["completedChunks"] == 1
    statuses = [r["status"] for r in chunk_rows(client, job["id"])]
    assert statuses == ["done"] + ["cancelled"] * 5
    assert transcript_row(client, job["episodeId"]) is None

    client.app.state.service.provider = MockProvider(delay_ms=0)
    client.post(f"/jobs/{job['id']}/retry")
    assert wait_for_job(client, job["id"])["status"] == "completed"


def test_cancelling_a_queued_job_never_runs_it(make_client, audio):
    client = make_client(start_runner=False)
    job = upload(client, audio["short"])["body"]["job"]
    cancelled = client.post(f"/jobs/{job['id']}/cancel").json()
    assert cancelled["status"] == "cancelled"
    assert cancelled["failure"]["stage"] is None
    # A runner picking it up later must not run it.
    client.app.state.runner.pipeline.run(job["id"])
    assert client.get(f"/jobs/{job['id']}").json()["status"] == "cancelled"
    assert chunk_rows(client, job["id"]) == []


def test_cancel_of_a_finished_job_is_a_conflict(client, audio):
    job = upload(client, audio["short"])["body"]["job"]
    wait_for_job(client, job["id"])
    response = client.post(f"/jobs/{job['id']}/cancel")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "JOB_NOT_ACTIVE"


def test_worker_restart_marks_running_jobs_and_requires_explicit_retry(
    make_client, settings, audio
):
    first = make_client(start_runner=False)
    job = upload(first, audio["short"])["body"]["job"]
    # Simulate a worker that died mid-job.
    with sqlite3.connect(first.app.state.db.path) as conn:
        conn.execute(
            "UPDATE jobs SET status = 'running', stage = 'transcribing' WHERE id = ?", (job["id"],)
        )
    first.__exit__(None, None, None)

    second = make_client()  # starting the runner performs recovery
    restarted = second.get(f"/jobs/{job['id']}").json()
    assert restarted["status"] == "failed"
    assert restarted["failure"]["code"] == "WORKER_RESTARTED"
    assert restarted["failure"]["stage"] == "transcribing"
    assert restarted["failure"]["retryable"] is True

    second.post(f"/jobs/{job['id']}/retry")
    assert wait_for_job(second, job["id"])["status"] == "completed"


def test_queued_jobs_survive_a_restart_and_run(make_client, audio):
    first = make_client(start_runner=False)
    job = upload(first, audio["short"])["body"]["job"]
    first.__exit__(None, None, None)
    second = make_client()
    assert wait_for_job(second, job["id"])["status"] == "completed"


@pytest.mark.parametrize("bad", ["../etc", "ep-NOTHEX00000", "x"])
def test_job_and_episode_lookups_reject_malformed_ids(client, bad):
    assert client.get(f"/jobs/{bad}").status_code == 404
    assert client.get(f"/episodes/{bad}").status_code == 404
