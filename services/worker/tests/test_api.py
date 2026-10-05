"""HTTP API behaviour: upload validation, listing, transcript, range requests, deletion."""

from __future__ import annotations

import json

from conftest import DEMO_AUDIO, upload, wait_for_job

from pebble_worker.contract import parse_job, parse_manifest, parse_transcript, parse_worker_health


def test_health_matches_the_contract(client, settings):
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert parse_worker_health(body).ok
    assert body["status"] == "ok"
    assert body["providers"][0]["kind"] == "mock"


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


def test_delete_removes_every_trace_of_one_episode_and_nothing_else(make_client, settings, audio):
    import sqlite3

    client = make_client()
    gone = upload(client, audio["short"])["body"]["job"]
    kept = upload(client, audio["short"])["body"]["job"]
    for job in (gone, kept):
        wait_for_job(client, job["id"])
    root = settings.data_dir
    outside = root.parent / "outside-marker"
    outside.write_text("untouched")
    before = {p for p in root.rglob("*")}

    assert client.delete(f"/episodes/{gone['episodeId']}").status_code == 204

    removed = before - {p for p in root.rglob("*")}
    assert removed, "the episode's files were removed"
    assert all(gone["episodeId"] in p.relative_to(root).parts for p in removed)  # only its files
    assert not (root / "episodes" / gone["episodeId"]).exists()
    assert (root / "episodes" / kept["episodeId"]).is_dir()
    assert outside.read_text() == "untouched"

    with sqlite3.connect(root / "pebble.db") as db:
        for table, column, value in (
            ("episodes", "id", gone["episodeId"]),
            ("jobs", "id", gone["id"]),
            ("chunks", "job_id", gone["id"]),
            ("transcripts", "episode_id", gone["episodeId"]),
        ):
            count = db.execute(f"SELECT COUNT(*) FROM {table} WHERE {column} = ?", (value,))
            assert count.fetchone()[0] == 0, table
        assert db.execute("SELECT COUNT(*) FROM transcripts").fetchone()[0] == 1
    assert client.get(f"/episodes/{kept['episodeId']}/transcript").status_code == 200


INVENTED_FILENAME = "invented-private-interview-0412"  # never a real file name


def test_the_original_file_name_is_never_served_or_logged(make_client, settings, audio, tmp_path):
    import shutil

    renamed = tmp_path / f"{INVENTED_FILENAME}{audio['short'].suffix}"
    shutil.copy(audio["short"], renamed)
    client = make_client()
    created = upload(client, renamed, title="My renamed episode")
    assert created["status"] == 201
    job = wait_for_job(client, created["body"]["job"]["id"])
    episode_id = job["episodeId"]

    episode = client.get(f"/episodes/{episode_id}").json()
    assert episode["title"] == "My renamed episode"
    assert episode["description"] == "Local audio"
    responses = [
        client.get("/episodes").text,
        client.get(f"/episodes/{episode_id}").text,
        client.get(f"/episodes/{episode_id}/transcript").text,
        client.get("/jobs").text,
        client.get(f"/jobs/{job['id']}").text,
        client.get("/health").text,
        json.dumps(created["body"]),
    ]
    for body in responses:
        assert INVENTED_FILENAME not in body
    for log in (settings.data_dir / "logs").glob("*.log"):
        assert INVENTED_FILENAME not in log.read_text()
    # Kept privately for internal bookkeeping only.
    import sqlite3

    with sqlite3.connect(settings.data_dir / "pebble.db") as db:
        stored = db.execute("SELECT original_filename FROM episodes").fetchone()[0]
    assert stored.startswith(INVENTED_FILENAME)


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


def test_health_reports_the_data_directory_without_other_paths(client, settings):
    body = client.get("/health").json()
    assert body["dataDir"]["writable"] is True and body["dataDir"]["hint"] is None
    assert body["dataDir"]["path"].endswith("pebble")


def test_health_explains_an_unwritable_data_directory(client, settings):
    settings.data_dir.chmod(0o500)
    try:
        body = client.get("/health").json()
    finally:
        settings.data_dir.chmod(0o700)
    assert body["status"] == "degraded"
    assert body["dataDirWritable"] is False
    assert "PEBBLE_DATA_DIR" in body["dataDir"]["hint"]


def test_display_path_abbreviates_home():
    from pathlib import Path

    from pebble_worker.health import display_path

    assert display_path(Path.home() / ".pebble") == "~/.pebble"
    assert display_path(Path("/Volumes/Archive/pebble")) == "/Volumes/Archive/pebble"


# --- Rename (1.7) ---------------------------------------------------------------------------


#: Invented. Chinese and Latin punctuation must survive a rename untouched.
PUNCTUATED = "第二期：慢慢听 — Part 2 (rev. #3)!"  # noqa: RUF001 — the full-width colon is the point


def _source_state(settings, episode_id: str) -> dict:
    """Every file under the episode's folder, with size and modification time."""
    root = settings.data_dir / "episodes" / episode_id
    return {
        str(path.relative_to(root)): (path.stat().st_size, path.stat().st_mtime_ns)
        for path in sorted(root.rglob("*"))
        if path.is_file() and "work" not in path.relative_to(root).parts
    }


def test_rename_changes_only_the_user_facing_title(make_client, settings, audio, tmp_path):
    import shutil
    import sqlite3

    named = tmp_path / f"{INVENTED_FILENAME}{audio['short'].suffix}"
    shutil.copy(audio["short"], named)
    client = make_client()
    job = wait_for_job(client, upload(client, named, title="First title")["body"]["job"]["id"])
    episode_id = job["episodeId"]
    before = _source_state(settings, episode_id)
    with sqlite3.connect(settings.data_dir / "pebble.db") as db:
        stored_before = db.execute(
            "SELECT original_filename, source_path FROM episodes WHERE id = ?", (episode_id,)
        ).fetchone()

    response = client.patch(f"/episodes/{episode_id}", json={"title": f"  {PUNCTUATED}  "})
    assert response.status_code == 200
    body = response.json()
    assert parse_job(body).ok
    assert body["episodeTitle"] == PUNCTUATED
    assert set(body) <= {
        "schemaVersion", "id", "episodeId", "episodeTitle", "status", "stage", "attempt",
        "progress", "failure", "provider", "createdAt", "updatedAt", "durationMs", "lineCount",
    }  # fmt: skip
    for text in (response.text, client.get("/jobs").text, client.get("/episodes").text):
        assert INVENTED_FILENAME not in text
        assert str(settings.data_dir) not in text and "source." not in text

    assert client.get(f"/episodes/{episode_id}").json()["title"] == body["episodeTitle"]
    assert client.get(f"/jobs/{job['id']}").json()["episodeTitle"] == body["episodeTitle"]
    # The audio and everything else about the episode stay exactly as they were.
    assert _source_state(settings, episode_id) == before
    with sqlite3.connect(settings.data_dir / "pebble.db") as db:
        stored_after = db.execute(
            "SELECT original_filename, source_path FROM episodes WHERE id = ?", (episode_id,)
        ).fetchone()
    assert stored_after == stored_before
    assert client.get(f"/episodes/{episode_id}/audio").status_code == 200


def test_rename_validates_the_title(client, audio):
    job = wait_for_job(client, upload(client, audio["short"])["body"]["job"]["id"])
    url = f"/episodes/{job['episodeId']}"

    def code(payload):
        response = client.patch(url, json=payload)
        return response.status_code, response.json().get("error", {}).get("code")

    for bad in ("", "   ", "x" * 201, "two\nlines", "tab\tinside", "a\u2028b"):
        assert code({"title": bad}) == (422, "INVALID_TITLE"), bad
    assert code({"title": 123}) == (422, "INVALID_REQUEST")
    assert code({"title": "ok", "originalFilename": "x.m4a"}) == (422, "INVALID_REQUEST")
    assert code({}) == (422, "INVALID_REQUEST")
    # Exactly 200 code points is fine, in any script.
    long_title = "听" * 199 + "!"
    response = client.patch(url, json={"title": long_title})
    assert response.status_code == 200 and response.json()["episodeTitle"] == long_title


def test_rename_unknown_episodes_are_not_found(client):
    for episode_id in ("ep-0123456789ab", "not-an-id", "..%2f..%2fetc"):
        response = client.patch(f"/episodes/{episode_id}", json={"title": "x"})
        assert response.status_code == 404


def test_rename_is_refused_while_processing(make_client, audio):
    client = make_client(start_runner=False)
    job = upload(client, audio["short"])["body"]["job"]
    response = client.patch(f"/episodes/{job['episodeId']}", json={"title": "New"})
    assert response.status_code == 409
    assert response.json()["error"] == {
        "code": "JOB_ACTIVE",
        "message": "This episode is still processing.",
    }
    assert client.get(f"/jobs/{job['id']}").json()["episodeTitle"] == "Morning walk"


def test_rename_works_for_cancelled_and_failed_episodes(make_client, audio):
    idle = make_client(start_runner=False)
    queued = upload(idle, audio["short"])["body"]["job"]
    assert idle.post(f"/jobs/{queued['id']}/cancel").json()["status"] == "cancelled"
    renamed = idle.patch(f"/episodes/{queued['episodeId']}", json={"title": "Stopped one"})
    assert renamed.status_code == 200 and renamed.json()["status"] == "cancelled"
    assert renamed.json()["episodeTitle"] == "Stopped one"

    client = make_client()
    broken = wait_for_job(client, upload(client, audio["not_audio"])["body"]["job"]["id"])
    assert broken["status"] == "failed"
    renamed = client.patch(f"/episodes/{broken['episodeId']}", json={"title": "Broken one"})
    assert renamed.status_code == 200 and renamed.json()["episodeTitle"] == "Broken one"


# --- Job duration and line count (1.7) ------------------------------------------------------


def test_jobs_report_duration_and_line_count_only_when_real(make_client, audio):
    idle = make_client(start_runner=False)
    queued = upload(idle, audio["short"])["body"]["job"]
    assert "durationMs" not in queued and "lineCount" not in queued
    idle.__exit__(None, None, None)

    client = make_client()
    done = wait_for_job(client, queued["id"])
    assert parse_job(done).ok
    assert 1400 <= done["durationMs"] <= 1600  # short.wav is 1.5 s
    transcript = client.get(f"/episodes/{done['episodeId']}/transcript").json()
    assert done["lineCount"] == len(transcript["segments"]) > 0
    assert client.get("/jobs").json()["jobs"][0]["lineCount"] == done["lineCount"]
