"""The local boundary: loopback binding, Host/Origin checks, CORS, and data containment."""

from __future__ import annotations

import sqlite3

import pytest
from conftest import upload, wait_for_job
from fastapi.testclient import TestClient

from pebble_worker.config import Settings
from pebble_worker.errors import ConfigError, StorageAccessError
from pebble_worker.storage import Storage

ALLOWED_ORIGIN = "http://localhost:5173"


# --- binding & configuration -----------------------------------------------------------------


@pytest.mark.parametrize("host", ["0.0.0.0", "localhost", "::", "::1", "192.168.1.20", ""])
def test_refuses_any_host_but_127_0_0_1(tmp_path, host):
    with pytest.raises(ConfigError, match=r"only listens on 127\.0\.0\.1"):
        Settings(data_dir=tmp_path, host=host)


@pytest.mark.parametrize(
    "origin",
    [
        "*",
        "https://localhost:5173",
        "http://evil.example",
        "http://localhost",
        "http://192.168.1.20:5173",
        "null",
    ],
)
def test_refuses_non_local_or_wildcard_origins(tmp_path, origin):
    with pytest.raises(ConfigError):
        Settings(data_dir=tmp_path, allowed_origins=(origin,))


# --- Host header (DNS rebinding) ----------------------------------------------------------


@pytest.mark.parametrize("host", ["127.0.0.1:8790", "localhost:8790", "127.0.0.1", "localhost"])
def test_accepts_loopback_host_headers(client, host):
    assert client.get("/health", headers={"Host": host}).status_code == 200


@pytest.mark.parametrize(
    "host",
    [
        "evil.example",
        "evil.example:8790",
        "192.168.1.20:8790",
        "0.0.0.0:8790",
        "127.0.0.1.evil.example",
    ],
)
def test_rejects_other_host_headers(client, host):
    assert client.get("/health", headers={"Host": host}).status_code == 400


# --- Origin / CORS ------------------------------------------------------------------------


@pytest.mark.parametrize(
    "origin",
    [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5175",
        "http://127.0.0.1:5175",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
    ],
)
def test_allowlisted_origins_get_exact_cors_headers(client, origin):
    response = client.get("/health", headers={"Origin": origin})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    assert "access-control-allow-credentials" not in response.headers


@pytest.mark.parametrize(
    "origin", ["http://evil.example", "http://localhost:3000", "https://localhost:5173", "null"]
)
def test_other_origins_are_rejected_outright(client, origin):
    response = client.get("/health", headers={"Origin": origin})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ORIGIN_NOT_ALLOWED"
    assert "access-control-allow-origin" not in response.headers


def test_cross_origin_form_post_cannot_create_jobs(client, audio):
    # A malicious page can submit a multipart form without a CORS preflight.
    with audio["short"].open("rb") as handle:
        response = client.post(
            "/episodes",
            headers={"Origin": "http://evil.example"},
            data={"title": "x", "ownershipConfirmed": "true"},
            files={"file": ("a.wav", handle, "audio/wav")},
        )
    assert response.status_code == 403
    assert client.get("/jobs").json()["jobs"] == []


def test_preflight_from_allowlisted_origin(client):
    response = client.options(
        "/episodes/ep-0123456789ab",
        headers={"Origin": ALLOWED_ORIGIN, "Access-Control-Request-Method": "DELETE"},
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == ALLOWED_ORIGIN
    assert "DELETE" in response.headers["access-control-allow-methods"]


def test_preflight_from_other_origin_is_rejected(client):
    response = client.options(
        "/jobs", headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "POST"}
    )
    assert response.status_code == 403


@pytest.mark.parametrize("site", ["cross-site", "same-site"])
def test_cross_site_browser_requests_without_origin_are_rejected(client, site):
    # e.g. <audio src="http://127.0.0.1:8790/..."> embedded on another website
    assert client.get("/health", headers={"Sec-Fetch-Site": site}).status_code == 403


@pytest.mark.parametrize("site", ["same-origin", "none"])
def test_direct_navigation_is_allowed(client, site):
    assert client.get("/health", headers={"Sec-Fetch-Site": site}).status_code == 200


# --- no extra surface -----------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        "/",
        "/docs",
        "/redoc",
        "/openapi.json",
        "/data",
        "/pebble.db",
        "/episodes/ep-0123456789ab/../..",
    ],
)
def test_no_docs_listings_or_files_outside_the_api(client, path):
    response = client.get(path)
    assert response.status_code in (404, 405)


# --- data containment -----------------------------------------------------------------------


def test_storage_refuses_paths_outside_the_data_directory(tmp_path):
    storage = Storage(tmp_path / "pebble")
    storage.ensure()
    for bad in ("../outside.txt", "/etc/hosts", "episodes/../../x"):
        with pytest.raises(StorageAccessError):
            storage.resolve_relative(bad)
    for bad in ("../x", "ep-../../etc", "EP-0123456789AB"):
        with pytest.raises(StorageAccessError):
            storage.episode_dir(bad)


def test_storage_refuses_symlink_escapes(tmp_path):
    storage = Storage(tmp_path / "pebble")
    storage.ensure()
    outside = tmp_path / "secret.txt"
    outside.write_text("secret")
    (storage.root / "episodes" / "link").symlink_to(outside)
    with pytest.raises(StorageAccessError):
        storage.resolve_relative("episodes/link")


def test_audio_route_never_serves_a_tampered_path(client, settings, audio, tmp_path):
    job = upload(client, audio["short"])["body"]["job"]
    wait_for_job(client, job["id"])
    secret = tmp_path / "secret.txt"
    secret.write_text("not yours")
    with sqlite3.connect(client.app.state.db.path) as conn:
        conn.execute(
            "UPDATE episodes SET source_path = ? WHERE id = ?", (str(secret), job["episodeId"])
        )
    response = client.get(f"/episodes/{job['episodeId']}/audio")
    assert response.status_code == 404
    assert "not yours" not in response.text
    with sqlite3.connect(client.app.state.db.path) as conn:
        conn.execute(
            "UPDATE episodes SET source_path = ? WHERE id = ?", ("../secret.txt", job["episodeId"])
        )
    assert client.get(f"/episodes/{job['episodeId']}/audio").status_code == 404


def test_data_directory_and_files_are_private(client, settings, audio):
    job = upload(client, audio["short"])["body"]["job"]
    wait_for_job(client, job["id"])
    root = settings.data_dir
    assert root.stat().st_mode & 0o777 == 0o700
    episode_dir = root / "episodes" / job["episodeId"]
    assert episode_dir.stat().st_mode & 0o777 == 0o700
    [source] = episode_dir.glob("source.*")
    assert source.stat().st_mode & 0o777 == 0o600
    assert (root / "pebble.db").stat().st_mode & 0o777 == 0o600


def test_uploads_spool_inside_the_data_directory(client, settings):
    import tempfile

    assert tempfile.gettempdir() == str((settings.data_dir / "tmp").resolve())


def test_testclient_default_host_is_rejected(make_client, settings):
    # Sanity check that the Host guard is really active (TestClient defaults to "testserver").
    client = make_client()
    plain = TestClient(client.app)
    assert plain.get("/health").status_code == 400
