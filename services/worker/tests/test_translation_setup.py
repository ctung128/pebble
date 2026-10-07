"""
Translation slice 3 (ADR 0008): configuration, migration 2, consent routes and the health block.
Invented data, temporary databases and a sentinel fake key only; no network.
"""

from __future__ import annotations

import json
import logging
import pickle
import socket
import sqlite3
from datetime import UTC, datetime

import pytest
from conftest import EXAMPLES, WORKER_URL, upload, wait_for_job
from fastapi.testclient import TestClient

from pebble_worker.api import create_app
from pebble_worker.config import Settings
from pebble_worker.contract import CURRENT_SCHEMA_VERSION, parse_worker_health
from pebble_worker.db import MIGRATIONS, Database
from pebble_worker.errors import ConfigError
from pebble_worker.translation import REQUESTS_IMPLEMENTED
from pebble_worker.translation.config import SecretKey, TranslationSettings
from pebble_worker.translation.store import (
    CONSENT_VERSION,
    current_period,
    translation_health,
)

#: Invented; not a real key. Every leak test searches for it.
SENTINEL = "pebble-test-key-SENTINEL-7d1c9e:fx"
ORIGIN = "http://localhost:5175"
CONSENT_BODY = {"schemaVersion": "1.8", "provider": "deepl", "consentVersion": CONSENT_VERSION}


def env_for(tmp_path, **extra: str) -> dict[str, str]:
    return {"PEBBLE_DATA_DIR": str(tmp_path / "pebble"), **extra}


def configured_env(tmp_path, **extra: str) -> dict[str, str]:
    return env_for(tmp_path, PEBBLE_TRANSLATION_PROVIDER="deepl", DEEPL_AUTH_KEY=SENTINEL, **extra)


@pytest.fixture
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("translation setup must not use the network")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)


@pytest.fixture
def make(tmp_path, no_network):
    clients: list[TestClient] = []

    def factory(env: dict[str, str] | None = None) -> TestClient:
        settings = Settings.from_env(env or configured_env(tmp_path), mock_delay_ms=0)
        client = TestClient(create_app(settings, start_runner=False), base_url=WORKER_URL)
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for client in clients:
        client.__exit__(None, None, None)


def put_consent(client: TestClient, body: object = CONSENT_BODY, **kwargs):
    return client.put(
        "/translation/consent",
        content=json.dumps(body).encode(),
        headers={"content-type": "application/json", "origin": ORIGIN, **kwargs},
    )


# --- Configuration -----------------------------------------------------------------------


def test_off_by_default():
    t = TranslationSettings.from_env({})
    assert (t.configured, t.auth_key, t.monthly_request_limit, t.monthly_character_limit) == (
        False,
        None,
        300,
        30000,
    )


def test_all_four_variables():
    t = TranslationSettings.from_env(
        {
            "PEBBLE_TRANSLATION_PROVIDER": "DeepL",
            "DEEPL_AUTH_KEY": SENTINEL,
            "PEBBLE_TRANSLATION_MONTHLY_REQUEST_LIMIT": "12",
            "PEBBLE_TRANSLATION_MONTHLY_CHARACTER_LIMIT": "3456",
        }
    )
    assert t.provider == "deepl" and t.auth_key is not None
    assert t.auth_key.reveal() == SENTINEL
    assert (t.monthly_request_limit, t.monthly_character_limit) == (12, 3456)


@pytest.mark.parametrize("key", [None, ""], ids=["no key", "empty key"])
def test_provider_without_a_key_turns_translation_off(key):
    env = {"PEBBLE_TRANSLATION_PROVIDER": "deepl"}
    if key is not None:
        env["DEEPL_AUTH_KEY"] = key
    t = TranslationSettings.from_env(env)
    assert (t.configured, t.auth_key, t.key_missing) == (False, None, True)


def test_a_key_without_the_provider_is_not_loaded():
    t = TranslationSettings.from_env({"DEEPL_AUTH_KEY": SENTINEL})
    assert not t.configured and t.auth_key is None


@pytest.mark.parametrize(
    "env",
    [
        {"PEBBLE_TRANSLATION_PROVIDER": "deepl", "DEEPL_AUTH_KEY": f"{SENTINEL} x"},
        {"PEBBLE_TRANSLATION_PROVIDER": "deepl", "DEEPL_AUTH_KEY": f"{SENTINEL}\n"},
        {"PEBBLE_TRANSLATION_PROVIDER": "deepl", "DEEPL_AUTH_KEY": "k" * 513},
        {"PEBBLE_TRANSLATION_PROVIDER": SENTINEL, "DEEPL_AUTH_KEY": SENTINEL},
        {"PEBBLE_TRANSLATION_PROVIDER": "google", "DEEPL_AUTH_KEY": SENTINEL},
    ],
    ids=[
        "key with a space",
        "key with a newline",
        "key too long",
        "key pasted into the provider variable",
        "unknown provider",
    ],
)
def test_bad_translation_configuration_stops_without_echoing_values(env):
    with pytest.raises(ConfigError) as error:
        TranslationSettings.from_env(env)
    assert SENTINEL not in str(error.value) and SENTINEL not in repr(error.value)
    assert "google" not in str(error.value)


@pytest.mark.parametrize("value", ["1", "300", "1000000000", " 42 "])
@pytest.mark.parametrize(
    "name",
    ["PEBBLE_TRANSLATION_MONTHLY_REQUEST_LIMIT", "PEBBLE_TRANSLATION_MONTHLY_CHARACTER_LIMIT"],
)
def test_valid_limits(name, value):
    t = TranslationSettings.from_env({name: value})
    assert getattr(t, name.lower().removeprefix("pebble_translation_")) == int(value)


@pytest.mark.parametrize("value", ["0", "-1", "1.5", "abc", "1e3", "1000000001", "٣"])
@pytest.mark.parametrize(
    "name",
    ["PEBBLE_TRANSLATION_MONTHLY_REQUEST_LIMIT", "PEBBLE_TRANSLATION_MONTHLY_CHARACTER_LIMIT"],
)
def test_invalid_limits(name, value):
    with pytest.raises(ConfigError, match=name):
        TranslationSettings.from_env(
            {"PEBBLE_TRANSLATION_PROVIDER": "deepl", "DEEPL_AUTH_KEY": SENTINEL, name: value}
        )


def test_empty_limits_use_the_defaults():
    t = TranslationSettings.from_env(
        {
            "PEBBLE_TRANSLATION_MONTHLY_REQUEST_LIMIT": "",
            "PEBBLE_TRANSLATION_MONTHLY_CHARACTER_LIMIT": "",
        }
    )
    assert (t.monthly_request_limit, t.monthly_character_limit) == (300, 30000)


def test_the_key_never_prints(tmp_path):
    key = SecretKey(SENTINEL)
    for text in (repr(key), str(key), f"{key}", f"{key!r}", format(key, "s")):
        assert SENTINEL not in text
    settings = Settings.from_env(configured_env(tmp_path))
    assert SENTINEL not in repr(settings) and SENTINEL not in str(settings)
    with pytest.raises(TypeError):
        pickle.dumps(key)


# --- Migration ---------------------------------------------------------------------------


def v1_database(path):
    """A database at schema version 1 with one invented episode, job, chunk and transcript."""
    conn = sqlite3.connect(path)
    conn.executescript(f"BEGIN; {MIGRATIONS[0]}; PRAGMA user_version = 1; COMMIT;")
    conn.executescript(
        """
        INSERT INTO episodes VALUES ('ep-aaaaaaaaaaaa', 'Invented', 'invented.m4a',
          'episodes/ep-aaaaaaaaaaaa/source.m4a', 'audio/mp4', 9000, 'zh-CN',
          '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
        INSERT INTO jobs VALUES ('job-aaaaaaaaaaaa', 'ep-aaaaaaaaaaaa', 'completed', 'merging', 1,
          'mock', 'mock', 1, 1, NULL, 0, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
        INSERT INTO chunks VALUES ('job-aaaaaaaaaaaa', 1, 0, 0, 9000, 'end', 'c0.wav', 'done',
          '[]', '2026-10-01T00:00:00Z');
        INSERT INTO transcripts VALUES ('ep-aaaaaaaaaaaa', 'job-aaaaaaaaaaaa', 1, '{}',
          '2026-10-01T00:00:00Z');
        """
    )
    conn.close()


def rows(path, table):
    conn = sqlite3.connect(path)
    try:
        return conn.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()
    finally:
        conn.close()


def test_migrates_from_version_1_and_keeps_every_existing_row(tmp_path):
    path = tmp_path / "pebble.db"
    v1_database(path)
    before = {t: rows(path, t) for t in ("episodes", "jobs", "chunks", "transcripts")}
    db = Database(path)
    assert db.migrate() == 2
    assert db.schema_version == 2
    assert {t: rows(path, t) for t in before} == before
    for table in ("translations", "translation_usage", "translation_attempts"):
        assert rows(path, table) == []


def test_migrating_again_is_a_no_op(tmp_path):
    path = tmp_path / "pebble.db"
    v1_database(path)
    db = Database(path)
    db.migrate()
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO translation_consent VALUES ('deepl', ?, '2026-10-06T00:00:00Z')",
            (CONSENT_VERSION,),
        )
    db.migrate()
    db.migrate()
    assert db.schema_version == 2
    assert len(rows(path, "translation_consent")) == 1


def test_repeated_startup_on_the_same_data_directory(tmp_path, make):
    make()
    assert put_consent(make()).status_code == 200
    assert Database(tmp_path / "pebble" / "pebble.db").schema_version == 2


def insert_translation(conn, episode_id, segment_id="seg-0001", fingerprint="a" * 64):
    conn.execute(
        "INSERT INTO translations VALUES (?, ?, ?, 'deepl', 'EN-US', 1, 3, 'Invented.', "
        "'2026-10-06T00:00:00Z')",
        (episode_id, segment_id, fingerprint),
    )


def test_translations_need_an_episode_and_are_deleted_with_it(tmp_path):
    path = tmp_path / "pebble.db"
    v1_database(path)
    db = Database(path)
    db.migrate()
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO episodes SELECT 'ep-bbbbbbbbbbbb', title, original_filename, "
            "source_path, mime_type, duration_ms, language, ownership_confirmed_at, created_at "
            "FROM episodes WHERE id = 'ep-aaaaaaaaaaaa'"
        )
        insert_translation(conn, "ep-aaaaaaaaaaaa")
        insert_translation(conn, "ep-aaaaaaaaaaaa", fingerprint="b" * 64)
        insert_translation(conn, "ep-bbbbbbbbbbbb")
    with pytest.raises(sqlite3.IntegrityError), db.tx() as conn:
        insert_translation(conn, "ep-cccccccccccc")
    with pytest.raises(sqlite3.IntegrityError), db.tx() as conn:
        insert_translation(conn, "ep-bbbbbbbbbbbb")  # same episode, segment and fingerprint
    with db.tx() as conn:
        conn.execute("DELETE FROM episodes WHERE id = 'ep-aaaaaaaaaaaa'")
        left = conn.execute("SELECT episode_id FROM translations").fetchall()
    assert [r["episode_id"] for r in left] == ["ep-bbbbbbbbbbbb"]


def test_attempt_records_hold_no_text_or_identifiers(tmp_path):
    db = Database(tmp_path / "pebble.db")
    db.migrate()
    with db.tx() as conn:
        columns = {r["name"] for r in conn.execute("PRAGMA table_info(translation_attempts)")}
        translation_columns = {r["name"] for r in conn.execute("PRAGMA table_info(translations)")}
    assert columns == {
        "id",
        "period",
        "characters",
        "consent_version",
        "status",
        "failure_code",
        "http_status",
        "created_at",
        "updated_at",
    }
    assert "source_text" not in translation_columns and "key" not in translation_columns


# --- Consent routes ------------------------------------------------------------------------


def test_grant_and_withdraw(make):
    client = make()
    granted = put_consent(client)
    assert granted.status_code == 200
    body = granted.json()
    assert body["status"] == "current" and body["consentVersion"] == CONSENT_VERSION
    assert body["grantedAt"] and body["schemaVersion"] == CURRENT_SCHEMA_VERSION
    for _ in range(2):  # idempotent
        withdrawn = client.delete("/translation/consent", headers={"origin": ORIGIN})
        assert withdrawn.status_code == 200
        assert withdrawn.json()["status"] == "required" and withdrawn.json()["grantedAt"] is None
    assert put_consent(client).json()["status"] == "current"


def test_only_the_current_consent_version_is_granted(make, tmp_path):
    client = make()
    response = put_consent(client, {**CONSENT_BODY, "consentVersion": "deepl-2025-01"})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "TRANSLATION_CONSENT_REQUIRED"
    assert rows(tmp_path / "pebble" / "pebble.db", "translation_consent") == []


def test_an_older_stored_version_counts_as_required(make, tmp_path):
    client = make()
    db = Database(tmp_path / "pebble" / "pebble.db")
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO translation_consent VALUES ('deepl', 'deepl-2025-01', "
            "'2025-01-01T00:00:00Z')"
        )
    assert client.delete("/translation/consent").json()["status"] == "required"
    health = translation_health(Settings.from_env(configured_env(tmp_path)).translation, db)
    assert (health.consent, health.new_requests) == ("required", "consent_required")


def test_consent_cannot_be_granted_while_translation_is_off(make, tmp_path):
    client = make(env_for(tmp_path))
    response = put_consent(client)
    assert response.status_code == 409 and response.json()["error"]["code"] == "TRANSLATION_OFF"
    assert client.delete("/translation/consent").status_code == 200  # withdrawing is always safe


@pytest.mark.parametrize(
    "body",
    [
        {"provider": "deepl", "consentVersion": CONSENT_VERSION},
        {**CONSENT_BODY, "schemaVersion": "2.0"},
        {**CONSENT_BODY, "provider": "other"},
        {"schemaVersion": "1.8", "provider": "deepl"},
        [],
        "consent",
    ],
    ids=["no version", "other major", "other provider", "no consent version", "array", "string"],
)
def test_malformed_consent_requests(make, body):
    response = put_consent(make(), body)
    assert response.status_code == 422 and response.json()["error"]["code"] == "INVALID_REQUEST"


def test_invalid_json_is_refused(make):
    response = make().put(
        "/translation/consent", content=b"{not json", headers={"content-type": "application/json"}
    )
    assert response.status_code == 422


@pytest.mark.parametrize("content_type", ["text/plain", "application/x-www-form-urlencoded", ""])
def test_consent_needs_a_json_content_type(make, content_type):
    response = make().put(
        "/translation/consent",
        content=json.dumps(CONSENT_BODY).encode(),
        headers={"content-type": content_type},
    )
    assert response.status_code == 415
    assert response.json()["error"]["code"] == "UNSUPPORTED_CONTENT_TYPE"


def test_json_with_a_charset_is_accepted(make):
    response = put_consent(make(), **{"content-type": "application/json; charset=utf-8"})
    assert response.status_code == 200


def test_oversized_consent_requests_are_refused_before_reading(make):
    body = {**CONSENT_BODY, "padding": "x" * 2000}
    response = put_consent(make(), body)
    assert response.status_code == 413 and response.json()["error"]["code"] == "REQUEST_TOO_LARGE"


def test_chunked_consent_requests_are_refused(make):
    def chunks():
        yield json.dumps(CONSENT_BODY).encode()

    response = make().put(
        "/translation/consent", content=chunks(), headers={"content-type": "application/json"}
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_LENGTH"


def test_consent_keeps_the_origin_and_host_checks(make):
    client = make()
    assert put_consent(client, origin="https://example.com").status_code == 403
    assert put_consent(client, host="evil.example").status_code == 400
    assert (
        client.delete("/translation/consent", headers={"origin": "https://example.com"}).status_code
        == 403
    )
    preflight = client.options(
        "/translation/consent",
        headers={"origin": ORIGIN, "access-control-request-method": "PUT"},
    )
    assert preflight.status_code == 200
    assert "PUT" in preflight.headers["access-control-allow-methods"]


# --- Health ----------------------------------------------------------------------------


def test_health_reports_translation_now_that_requests_exist(make, tmp_path):
    assert REQUESTS_IMPLEMENTED is True
    client = make()
    before = client.get("/health").json()
    assert before["schemaVersion"] == "1.8"
    assert before["translation"]["newRequests"] == "consent_required"
    put_consent(client)
    assert client.get("/health").json()["translation"]["newRequests"] == "available"
    off = make(env_for(tmp_path / "off")).get("/health").json()["translation"]
    assert (off["configured"], off["consent"], off["newRequests"]) == (
        False,
        "not_configured",
        "off",
    )


NOW = datetime(2026, 10, 6, 12, tzinfo=UTC)


def health_with(block) -> dict:
    """The block inside an otherwise valid health payload, for the shared validator."""
    payload = json.loads((EXAMPLES / "valid" / "worker-health-translation.json").read_text())
    payload["translation"] = block.dump()
    return payload


def test_health_block_states(tmp_path):
    db = Database(tmp_path / "pebble.db")
    db.migrate()
    off = translation_health(TranslationSettings(), db, NOW)
    on = TranslationSettings(provider="deepl", auth_key=SecretKey(SENTINEL))
    assert (off.configured, off.consent, off.new_requests) == (False, "not_configured", "off")
    needs = translation_health(on, db, NOW)
    assert (needs.consent, needs.new_requests) == ("required", "consent_required")
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO translation_consent VALUES ('deepl', ?, '2026-10-06T00:00:00Z')",
            (CONSENT_VERSION,),
        )
    ready = translation_health(on, db, NOW)
    assert (ready.consent, ready.new_requests) == ("current", "available")
    with db.tx() as conn:
        conn.execute("INSERT INTO translation_usage VALUES ('2026-10', 300, 10)")
        conn.execute("INSERT INTO translation_usage VALUES ('2026-09', 1, 1)")
    full = translation_health(on, db, NOW)
    assert full.new_requests == "local_limit_reached"
    assert (full.limits.period, full.limits.requests_used) == ("2026-10", 300)
    next_month = translation_health(on, db, datetime(2026, 11, 1, tzinfo=UTC))
    assert next_month.new_requests == "available" and next_month.limits.requests_used == 0
    for block in (off, needs, ready, full, next_month):
        assert parse_worker_health(health_with(block)).ok
        assert SENTINEL not in json.dumps(block.dump())


def test_periods_are_utc_calendar_months():
    assert current_period(datetime(2026, 10, 31, 23, 59, tzinfo=UTC)) == "2026-10"
    assert current_period(datetime(2026, 11, 1, 0, 0, tzinfo=UTC)) == "2026-11"


# --- The key never leaves -----------------------------------------------------------------


def test_fake_key_never_appears_in_responses_logs_or_the_database(make, tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    client = make()
    responses = [
        client.get("/health"),
        put_consent(client),
        put_consent(client, {**CONSENT_BODY, "consentVersion": "deepl-2025-01"}),
        put_consent(client, {"bad": True}),
        client.put("/translation/consent", content=b"x", headers={"content-type": "text/plain"}),
        client.delete("/translation/consent"),
        client.get("/episodes"),
        client.get("/episodes/ep-000000000000"),
        client.get("/jobs"),
        client.get("/no-such-route"),
    ]
    for response in responses:
        assert SENTINEL not in response.text
        assert all(SENTINEL not in v for v in response.headers.values())
    assert SENTINEL not in caplog.text
    data = tmp_path / "pebble"
    for path in data.rglob("*"):
        if path.is_file():
            assert SENTINEL.encode() not in path.read_bytes(), path.name
    conn = sqlite3.connect(data / "pebble.db")
    try:
        tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        for table in tables:
            assert SENTINEL not in repr(conn.execute(f"SELECT * FROM {table}").fetchall())
    finally:
        conn.close()


def test_no_network_during_setup_consent_or_health(make):
    """The no_network fixture fails any socket connect; these all run under it."""
    client = make()
    assert client.get("/health").status_code == 200
    assert put_consent(client).status_code == 200
    assert client.delete("/translation/consent").status_code == 200


def test_fake_key_never_appears_in_serve_or_doctor_output_or_the_worker_log(
    tmp_path, monkeypatch, capsys, no_network
):
    """`serve` as `pebble:start` runs it, with uvicorn replaced by in-process requests."""
    import uvicorn

    from pebble_worker import cli

    for name, value in configured_env(tmp_path).items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(cli, "port_state", lambda host, port: "free")
    seen: list[str] = []

    def fake_run(app, **kwargs):
        with TestClient(app, base_url=WORKER_URL) as client:
            seen.extend(
                r.text
                for r in (
                    client.get("/health"),
                    put_consent(client),
                    put_consent(client, {"bad": True}),
                    client.delete("/translation/consent"),
                )
            )

    monkeypatch.setattr(uvicorn, "run", fake_run)
    pebble_log = logging.getLogger("pebble")
    handlers_before = list(pebble_log.handlers)
    try:
        assert cli.main(["serve"]) == 0
        assert cli.main(["doctor"]) in (0, 1)
    finally:
        for handler in set(pebble_log.handlers) - set(handlers_before):
            pebble_log.removeHandler(handler)
            handler.close()
    out = capsys.readouterr()
    assert len(seen) == 4 and all(SENTINEL not in text for text in seen)
    assert SENTINEL not in out.out and SENTINEL not in out.err
    log = tmp_path / "pebble" / "logs" / "worker.log"
    assert log.exists() and SENTINEL not in log.read_text()


def test_bad_translation_configuration_stops_serve_without_echoing_the_key(
    tmp_path, monkeypatch, capsys
):
    from pebble_worker import cli

    for name, value in env_for(
        tmp_path, PEBBLE_TRANSLATION_PROVIDER=SENTINEL, DEEPL_AUTH_KEY=SENTINEL
    ).items():
        monkeypatch.setenv(name, value)
    assert cli.main(["serve"]) == 2
    out = capsys.readouterr()
    assert "PEBBLE_TRANSLATION_PROVIDER must be unset or deepl" in out.err
    assert SENTINEL not in out.out and SENTINEL not in out.err


# --- A missing key never blocks Pebble ------------------------------------------------------


def test_missing_key_leaves_transcription_working_and_translation_off(tmp_path, audio, no_network):
    settings = Settings.from_env(
        env_for(tmp_path, PEBBLE_TRANSLATION_PROVIDER="deepl"), mock_delay_ms=0
    )
    assert settings.translation.key_missing and not settings.translation.configured
    with TestClient(create_app(settings), base_url=WORKER_URL) as client:
        uploaded = upload(client, audio["short"])
        assert uploaded["status"] == 201
        job = uploaded["body"]["job"]
        assert wait_for_job(client, job["id"])["status"] == "completed"
        assert client.get("/health").json()["status"] in ("ok", "degraded")
        refused = put_consent(client)
        assert refused.status_code == 409
        assert refused.json()["error"]["code"] == "TRANSLATION_OFF"
        assert client.delete("/translation/consent").status_code == 200
    db = Database(tmp_path / "pebble" / "pebble.db")
    health = translation_health(settings.translation, db)
    assert (health.configured, health.consent, health.new_requests) == (
        False,
        "not_configured",
        "off",
    )


def test_serve_says_translation_is_off_when_the_key_is_missing(
    tmp_path, monkeypatch, capsys, no_network
):
    import uvicorn

    from pebble_worker import cli

    for name, value in env_for(tmp_path, PEBBLE_TRANSLATION_PROVIDER="deepl").items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("DEEPL_AUTH_KEY", raising=False)
    monkeypatch.setattr(cli, "port_state", lambda host, port: "free")
    monkeypatch.setattr(uvicorn, "run", lambda app, **kwargs: None)
    pebble_log = logging.getLogger("pebble")
    handlers_before = list(pebble_log.handlers)
    try:
        assert cli.main(["serve"]) == 0
    finally:
        for handler in set(pebble_log.handlers) - set(handlers_before):
            pebble_log.removeHandler(handler)
            handler.close()
    err = capsys.readouterr().err
    assert "DEEPL_AUTH_KEY isn't, so English translation is off" in err


# --- Request size counts bytes actually received ----------------------------------------


def asgi_put(app, headers: list[tuple[bytes, bytes]], chunks: list[bytes]) -> tuple[int, dict]:
    """One raw ASGI request, so headers and body framing can disagree on purpose."""
    import asyncio

    messages = [
        {"type": "http.request", "body": chunk, "more_body": i < len(chunks) - 1}
        for i, chunk in enumerate(chunks)
    ] or [{"type": "http.request", "body": b"", "more_body": False}]
    sent: list[dict] = []

    async def receive():
        return messages.pop(0) if messages else {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "PUT",
        "scheme": "http",
        "path": "/translation/consent",
        "raw_path": b"/translation/consent",
        "query_string": b"",
        "root_path": "",
        "headers": [(b"host", b"127.0.0.1:8790"), *headers],
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 8790),
    }
    asyncio.run(app(scope, receive, send))
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, json.loads(body) if body else {}


JSON = (b"content-type", b"application/json")
GOOD = json.dumps(CONSENT_BODY).encode()


@pytest.fixture
def raw_app(tmp_path, no_network):
    return create_app(Settings.from_env(configured_env(tmp_path)), start_runner=False)


def test_raw_request_with_matching_length_is_accepted(raw_app):
    status, body = asgi_put(raw_app, [JSON, (b"content-length", str(len(GOOD)).encode())], [GOOD])
    assert status == 200 and body["status"] == "current"


def test_a_raw_request_without_any_length_is_refused(raw_app):
    status, body = asgi_put(raw_app, [JSON], [GOOD])
    assert status == 411 and body["error"]["code"] == "LENGTH_REQUIRED"


def test_more_bytes_than_declared_are_refused(raw_app):
    status, body = asgi_put(
        raw_app, [JSON, (b"content-length", b"40")], [GOOD[:30], b"x" * 600, b"x" * 600]
    )
    assert status == 413 and body["error"]["code"] == "REQUEST_TOO_LARGE"


def test_a_body_longer_than_declared_but_under_the_limit_is_refused(raw_app):
    status, body = asgi_put(raw_app, [JSON, (b"content-length", b"10")], [GOOD])
    assert status == 400 and body["error"]["code"] == "INVALID_LENGTH"


def test_fewer_bytes_than_declared_are_refused(raw_app):
    status, body = asgi_put(raw_app, [JSON, (b"content-length", b"500")], [GOOD])
    assert status == 400 and body["error"]["code"] == "INVALID_LENGTH"


@pytest.mark.parametrize(
    "headers",
    [
        [(b"content-length", b"10"), (b"content-length", b"10")],
        [(b"content-length", b"-1")],
        [(b"content-length", b"+10")],
        [(b"content-length", b"1e2")],
        [(b"content-length", b"10, 10")],
        [(b"content-length", b"9999999999")],
        [(b"content-length", b"10"), (b"transfer-encoding", b"chunked")],
        [(b"transfer-encoding", b"chunked")],
    ],
    ids=[
        "two lengths",
        "negative",
        "plus sign",
        "exponent",
        "list",
        "too many digits",
        "length and chunked",
        "chunked only",
    ],
)
def test_conflicting_or_invalid_lengths_are_refused(raw_app, headers):
    status, body = asgi_put(raw_app, [JSON, *headers], [GOOD])
    assert status == 400 and body["error"]["code"] == "INVALID_LENGTH"
    db = Database(raw_app.state.storage.db_path)
    with db.tx() as conn:
        assert conn.execute("SELECT COUNT(*) FROM translation_consent").fetchone()[0] == 0
