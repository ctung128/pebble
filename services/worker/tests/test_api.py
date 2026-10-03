"""HTTP API behaviour: upload validation, listing, transcript, range requests, deletion."""

from __future__ import annotations

from conftest import DEMO_AUDIO, upload, wait_for_job

from pebble_worker.contract import parse_job, parse_manifest, parse_transcript, parse_worker_health


def test_health_matches_the_contract_and_has_no_paths(client, settings):
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert parse_worker_health(body).ok
    assert body["status"] == "ok"
    assert body["providers"][0]["kind"] == "mock"
    assert str(settings.data_dir) not in response.text


def test_upload_requires_ownership_confirmation(client, audio):
    for value in ("false", "", "yes", "TRUE"):
        result = upload(client, audio["short"], confirmed=value)
        assert result["status"] == 422
        assert result["body"]["error"]["code"] == "OWNERSHIP_NOT_CONFIRMED"
    with audio["short"].open("rb") as handle:  # field missing entirely
        response = client.post(
            "/episodes", data={"title": "x"}, files={"file": ("a.wav", handle, "audio/wav")}
        )
    assert response.json()["error"]["code"] == "OWNERSHIP_NOT_CONFIRMED"
    assert client.get("/jobs").json()["jobs"] == []


def test_upload_rejects_unsupported_extensions_and_bad_titles(client, audio, tmp_path):
    doc = tmp_path / "notes.txt"
    doc.write_text("hello")
    result = upload(client, doc)
    assert result["status"] == 415 and result["body"]["error"]["code"] == "UNSUPPORTED_MEDIA"
    result = upload(client, audio["short"], title="   ")
    assert result["status"] == 422 and result["body"]["error"]["code"] == "INVALID_TITLE"


def test_upload_rejects_empty_files_and_cleans_up(client, settings, tmp_path):
    empty = tmp_path / "empty.m4a"
    empty.write_bytes(b"")
    result = upload(client, empty)
    assert result["status"] == 422 and result["body"]["error"]["code"] == "EMPTY_FILE"
    assert list((settings.data_dir / "episodes").iterdir()) == []


def test_upload_size_limit_is_enforced_before_reading(make_client, settings, audio):
    from dataclasses import replace

    client = make_client(settings=replace(settings, max_upload_bytes=1024))
    result = upload(client, audio["tone_gaps"])
    assert result["status"] == 413 and result["body"]["error"]["code"] == "FILE_TOO_LARGE"


def test_upload_without_content_length_is_refused(client):
    response = client.post(
        "/episodes",
        content=iter([b"--x\r\n"]),  # streamed: no Content-Length
        headers={"Content-Type": "multipart/form-data; boundary=x"},
    )
    assert response.status_code == 411


def test_full_flow_list_transcript_and_job_shapes(client, audio):
    job = upload(client, audio["tone_gaps"], title="  Morning walk  ")["body"]["job"]
    assert parse_job(job).ok and job["episodeTitle"] == "Morning walk"
    wait_for_job(client, job["id"])

    manifest = client.get("/episodes").json()
    assert parse_manifest(manifest).ok
    [episode] = manifest["episodes"]
    assert episode["id"] == job["episodeId"]
    assert episode["audio"] == {"src": f"episodes/{episode['id']}/audio", "mimeType": "audio/mp4"}
    assert episode["audioProvenance"]["kind"] == "user-provided"
    assert episode["audioProvenance"]["publishable"] is False
    assert client.get(f"/episodes/{episode['id']}").json() == episode

    transcript = client.get(f"/episodes/{episode['id']}/transcript").json()
    assert parse_transcript(transcript).ok
    assert transcript["provenance"]["kind"] == "mock"

    jobs = client.get("/jobs").json()
    assert [j["id"] for j in jobs["jobs"]] == [job["id"]]


def test_audio_supports_range_requests(client, audio):
    job = upload(client, audio["tone_gaps"])["body"]["job"]
    wait_for_job(client, job["id"])
    url = f"/episodes/{job['episodeId']}/audio"
    size = audio["tone_gaps"].stat().st_size

    full = client.get(url)
    assert full.status_code == 200
    assert full.headers["content-type"] == "audio/mp4"
    assert full.headers["accept-ranges"] == "bytes"
    assert len(full.content) == size

    partial = client.get(url, headers={"Range": "bytes=100-199"})
    assert partial.status_code == 206
    assert partial.headers["content-range"] == f"bytes 100-199/{size}"
    assert partial.content == full.content[100:200]

    tail = client.get(url, headers={"Range": f"bytes={size - 10}-"})
    assert tail.status_code == 206 and tail.content == full.content[-10:]


def test_unready_episodes_are_conflicts_not_partial_data(make_client, audio):
    client = make_client(start_runner=False)
    job = upload(client, audio["short"])["body"]["job"]
    for path in ("", "/audio", "/transcript"):
        response = client.get(f"/episodes/{job['episodeId']}{path}")
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "EPISODE_NOT_READY"


def test_delete_removes_audio_records_and_refuses_active_jobs(make_client, settings, audio):
    idle = make_client(start_runner=False)
    queued = upload(idle, audio["short"])["body"]["job"]
    response = idle.delete(f"/episodes/{queued['episodeId']}")
    assert response.status_code == 409 and response.json()["error"]["code"] == "JOB_ACTIVE"
    idle.__exit__(None, None, None)

    client = make_client()
    wait_for_job(client, queued["id"])
    episode_dir = settings.data_dir / "episodes" / queued["episodeId"]
    assert episode_dir.exists()
    assert client.delete(f"/episodes/{queued['episodeId']}").status_code == 204
    assert not episode_dir.exists()
    assert client.get(f"/jobs/{queued['id']}").status_code == 404
    assert client.get("/episodes").json()["episodes"] == []


def test_demo_fixture_end_to_end_with_default_chunking(make_client, settings):
    from dataclasses import replace

    from pebble_worker.config import ChunkingConfig

    client = make_client(settings=replace(settings, chunking=ChunkingConfig()))
    job = upload(client, DEMO_AUDIO, title="A Pebble on the Way Home")["body"]["job"]
    done = wait_for_job(client, job["id"])
    assert done["status"] == "completed"
    assert done["progress"] == {"completedChunks": 1, "totalChunks": 1}  # 34 s < 240 s max
    transcript = client.get(f"/episodes/{job['episodeId']}/transcript").json()
    assert abs(transcript["durationMs"] - 34_358) < 100
    assert transcript["provenance"]["kind"] == "mock"
    assert transcript["segments"][0]["text"].startswith("（模拟转写）")
