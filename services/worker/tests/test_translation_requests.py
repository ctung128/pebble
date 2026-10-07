"""
Translation slice 4 (ADR 0008): the DeepL client, the service and the two routes.
Invented transcripts, temporary databases, a fake provider or fake HTTPS transport, and a
sentinel key only. Any real network connection fails the test.
"""

from __future__ import annotations

import http.client
import json
import logging
import socket
import sqlite3
import ssl
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import ClassVar

import pytest
from conftest import WORKER_URL
from fastapi.testclient import TestClient

from pebble_worker.api import create_app
from pebble_worker.config import Settings
from pebble_worker.contract import (
    parse_episode_translations,
    parse_translation_result,
    parse_worker_health,
)
from pebble_worker.db import Database
from pebble_worker.translation.config import SecretKey
from pebble_worker.translation.deepl import (
    BUDGET_SECONDS,
    HOST,
    MAX_RESPONSE_BYTES,
    PATH,
    READ_CHUNK_BYTES,
    BoundedHTTPSConnection,
    Deadline,
    DeepLClient,
    ProviderFailure,
    StdlibHttpsTransport,
    TransportResponse,
    Watchdog,
    resolve,
)
from pebble_worker.translation.service import (
    JOIN_TIMEOUT_SECONDS,
    TranslationError,
    fingerprint,
)
from pebble_worker.translation.store import CONSENT_VERSION, grant_consent, withdraw_consent

SENTINEL = "pebble-test-key-SENTINEL-4b2e81:fx"  # invented; not a real key
RAW_PROVIDER = "RAW-PROVIDER-TEXT-must-never-escape"
ORIGIN = "http://localhost:5175"
#: Invented lines. The transcript holds ORIGINAL; learners submit SUBMITTED (an "edited" line),
#: which must never be stored anywhere.
ORIGINAL = "今天天气很好，"
SUBMITTED = "今天天气真好，"
OTHER = "我们一起去公园散步。"
ENGLISH = "The weather is really nice today,"


# --- Fakes -------------------------------------------------------------------------------


class FakeProvider:
    """Stands in for DeepLClient.translate. Optionally blocks until released."""

    def __init__(self, reply=lambda text: f"EN<{len(text)}>", gate: threading.Event | None = None):
        self.reply = reply
        self.gate = gate
        self.calls: list[str] = []
        self.started = threading.Event()
        self.lock = threading.Lock()

    def translate(self, text: str) -> str:
        with self.lock:
            self.calls.append(text)
        self.started.set()
        if self.gate is not None:
            assert self.gate.wait(10), "test gate never released"
        result = self.reply(text)
        if isinstance(result, Exception):
            raise result
        return result


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("tests must not use the network")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
    monkeypatch.setattr(http.client.HTTPSConnection, "connect", refuse)


def env_for(tmp_path, **extra):
    return {
        "PEBBLE_DATA_DIR": str(tmp_path / "pebble"),
        "PEBBLE_TRANSLATION_PROVIDER": "deepl",
        "DEEPL_AUTH_KEY": SENTINEL,
        **extra,
    }


class World:
    """A worker app with a fake provider, an invented transcript, and direct service access."""

    def __init__(self, tmp_path, provider: FakeProvider | None = None, **env: str) -> None:
        self.provider = provider or FakeProvider()
        settings = Settings.from_env(env_for(tmp_path, **env), mock_delay_ms=0)
        self.app = create_app(
            settings, start_runner=False, translation_client=lambda _: self.provider
        )
        self.client = TestClient(self.app, base_url=WORKER_URL)
        self.client.__enter__()
        self.db: Database = self.app.state.db
        self.service = self.app.state.translations

    def close(self) -> None:
        self.client.__exit__(None, None, None)

    def add_episode(self, episode_id="ep-aaaaaaaaaaaa", *, kind="asr", status="completed"):
        body = {
            "schemaVersion": "1.8",
            "episodeId": episode_id,
            "provenance": {"kind": kind},
            "segments": [
                {"id": "seg-0001", "text": ORIGINAL},
                {"id": "seg-0002", "text": OTHER},
            ],
        }
        job = f"job-{episode_id[3:]}"
        with self.db.tx() as conn:
            conn.execute(
                "INSERT INTO episodes VALUES (?, 'Invented', 'invented.m4a', 'x/source.m4a', "
                "'audio/mp4', 9000, 'zh-CN', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')",
                (episode_id,),
            )
            conn.execute(
                "INSERT INTO jobs VALUES (?, ?, ?, 'merging', 1, 'p', ?, 1, 1, NULL, 0, "
                "'2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')",
                (job, episode_id, status, "mock" if kind == "mock" else "asr"),
            )
            if status == "completed":
                conn.execute(
                    "INSERT INTO transcripts VALUES (?, ?, 1, ?, '2026-10-01T00:00:00Z')",
                    (episode_id, job, json.dumps(body, ensure_ascii=False)),
                )
        return episode_id

    def consent(self) -> None:
        grant_consent(self.db)

    def post(self, text=SUBMITTED, episode_id="ep-aaaaaaaaaaaa", segment_id="seg-0001", **headers):
        body = {
            "schemaVersion": "1.8",
            "episodeId": episode_id,
            "segmentId": segment_id,
            "text": text,
        }
        return self.client.post(
            "/translations",
            content=json.dumps(body, ensure_ascii=False).encode(),
            headers={"content-type": "application/json", "origin": ORIGIN, **headers},
        )

    def usage(self):
        with self.db.tx() as conn:
            row = conn.execute("SELECT requests, characters FROM translation_usage").fetchone()
        return (row["requests"], row["characters"]) if row else (0, 0)

    def attempts(self):
        with self.db.tx() as conn:
            return [
                dict(r)
                for r in conn.execute(
                    "SELECT status, failure_code, http_status, characters "
                    "FROM translation_attempts ORDER BY created_at"
                )
            ]

    def cache_rows(self, episode_id=None):
        with self.db.tx() as conn:
            query = "SELECT episode_id, segment_id, source_fingerprint, text FROM translations"
            rows = (
                conn.execute(query + " WHERE episode_id = ?", (episode_id,))
                if episode_id
                else conn.execute(query)
            )
            return [dict(r) for r in rows]


@pytest.fixture
def world(tmp_path):
    worlds: list[World] = []

    def make(provider=None, **env):
        w = World(tmp_path / f"w{len(worlds)}", provider, **env)
        worlds.append(w)
        return w

    yield make
    for w in worlds:
        w.close()


# --- The DeepL client and its HTTPS transport ---------------------------------------------


class FakeTransport:
    def __init__(self, status=200, body=b'{"translations":[{"text":"Invented."}]}', raises=None):
        self.status, self.body, self.raises = status, body, raises
        self.requests: list[tuple[str, dict, bytes]] = []

    def post(self, path, headers, body):
        self.requests.append((path, headers, body))
        if self.raises:
            raise self.raises
        return TransportResponse(self.status, self.body)


def test_request_carries_one_line_the_language_pair_and_header_auth_only():
    transport = FakeTransport()
    assert DeepLClient(SecretKey(SENTINEL), transport).translate(SUBMITTED) == "Invented."
    [(path, headers, body)] = transport.requests
    assert path == PATH == "/v2/translate"
    assert headers == {
        "Authorization": f"DeepL-Auth-Key {SENTINEL}",
        "Content-Type": "application/json",
    }
    assert json.loads(body) == {"text": [SUBMITTED], "source_lang": "ZH", "target_lang": "EN-US"}


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (301, "TRANSLATION_UNAVAILABLE"),
        (302, "TRANSLATION_UNAVAILABLE"),
        (307, "TRANSLATION_UNAVAILABLE"),
        (400, "TRANSLATION_REQUEST_REJECTED"),
        (403, "TRANSLATION_KEY_REJECTED"),
        (404, "TRANSLATION_UNAVAILABLE"),
        (413, "TRANSLATION_REQUEST_REJECTED"),
        (429, "TRANSLATION_RATE_LIMITED"),
        (456, "TRANSLATION_PROVIDER_QUOTA"),
        (500, "TRANSLATION_UNAVAILABLE"),
        (503, "TRANSLATION_UNAVAILABLE"),
        (529, "TRANSLATION_UNAVAILABLE"),
    ],
)
def test_http_statuses_map_to_fixed_codes(status, code):
    transport = FakeTransport(status, RAW_PROVIDER.encode())
    with pytest.raises(ProviderFailure) as failure:
        DeepLClient(SecretKey(SENTINEL), transport).translate(SUBMITTED)
    assert (failure.value.code, failure.value.http_status) == (code, status)
    assert RAW_PROVIDER not in str(failure.value) and SENTINEL not in str(failure.value)
    assert len(transport.requests) == 1  # never retried


@pytest.mark.parametrize(
    "raised",
    [
        TimeoutError(RAW_PROVIDER),
        ConnectionRefusedError(RAW_PROVIDER),
        ssl.SSLCertVerificationError(RAW_PROVIDER),
        http.client.RemoteDisconnected(RAW_PROVIDER),
    ],
    ids=["timeout", "refused", "certificate", "disconnected"],
)
def test_transport_errors_are_unavailable_and_quote_nothing(raised):
    with pytest.raises(ProviderFailure) as failure:
        DeepLClient(SecretKey(SENTINEL), FakeTransport(raises=raised)).translate(SUBMITTED)
    assert failure.value.code == "TRANSLATION_UNAVAILABLE"
    assert RAW_PROVIDER not in str(failure.value.__cause__)


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"{}",
        b'{"translations": []}',
        b'{"translations": [{"text": "a"}, {"text": "b"}]}',
        b'{"translations": [{"text": "   "}]}',
        b'{"translations": [{"text": 5}]}',
        b'{"translations": [{"text": "bad\\u0000text"}]}',
        json.dumps({"translations": [{"text": "a" * 2001}]}).encode(),
        b'{"translations": [{"text": "' + b"a" * (MAX_RESPONSE_BYTES + 10) + b'"}]}',
        b"\xff\xfe",
    ],
    ids=[
        "not json",
        "no translations",
        "empty list",
        "two translations",
        "blank",
        "not text",
        "control character",
        "too long",
        "response too large",
        "not utf-8",
    ],
)
def test_invalid_responses_are_unavailable(body):
    with pytest.raises(ProviderFailure) as failure:
        DeepLClient(SecretKey(SENTINEL), FakeTransport(200, body)).translate(SUBMITTED)
    assert failure.value.code == "TRANSLATION_UNAVAILABLE"


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeSock:
    def __init__(self) -> None:
        self.timeouts: list[float] = []
        self.was_shut_down = threading.Event()

    def settimeout(self, value: float) -> None:
        self.timeouts.append(value)

    def shutdown(self, how) -> None:
        self.was_shut_down.set()


class FakeResponse:
    def __init__(self, conn, status: int, chunks: list[bytes], chunk_delay: float) -> None:
        self.conn, self.status, self.chunks, self.chunk_delay = (
            conn,
            status,
            list(chunks),
            chunk_delay,
        )

    def read1(self, amount: int) -> bytes:
        self.conn.clock.advance(self.chunk_delay)
        if not self.chunks:
            return b""
        chunk = self.chunks.pop(0)
        if len(chunk) > amount:
            self.chunks.insert(0, chunk[amount:])
            chunk = chunk[:amount]
        return chunk


class FakeConnection:
    """Stands in for BoundedHTTPSConnection; time passes only on the fake clock."""

    made: ClassVar[list[FakeConnection]] = []

    def __init__(
        self,
        deadline,
        watchdog,
        context,
        *,
        clock,
        status=200,
        chunks=(b'{"translations":[{"text":"Invented."}]}',),
        chunk_delay=0.0,
        header_delay=0.0,
        connect_delay=0.0,
        gate=None,
    ):
        self.deadline, self.watchdog, self.context, self.clock = deadline, watchdog, context, clock
        self.status, self.chunks, self.chunk_delay = status, list(chunks), chunk_delay
        self.header_delay, self.connect_delay, self.gate = header_delay, connect_delay, gate
        self.sock = None
        self.closed = False
        self.sent = None
        FakeConnection.made.append(self)

    def request(self, method, path, body=None, headers=None):
        self.clock.advance(self.connect_delay)
        self.sock = FakeSock()
        self.watchdog.watch(self.sock)
        self.sent = (method, path, body, headers)

    def getresponse(self):
        if self.gate is not None:
            assert self.gate.wait(10), "test gate never released"
        self.clock.advance(self.header_delay)
        return FakeResponse(self, self.status, self.chunks, self.chunk_delay)

    def close(self):
        self.closed = True


def transport_with(clock, **options):
    FakeConnection.made.clear()
    return StdlibHttpsTransport(
        clock=clock,
        connection_factory=lambda d, w, c: FakeConnection(d, w, c, clock=clock, **options),
    )


def test_the_connection_is_verified_tls_to_the_fixed_host_and_never_a_proxy(monkeypatch):
    for name in ("HTTPS_PROXY", "https_proxy", "ALL_PROXY"):
        monkeypatch.setenv(name, "http://proxy.invalid:3128")
    deadline, watchdog = Deadline(BUDGET_SECONDS), Watchdog(BUDGET_SECONDS)
    conn = BoundedHTTPSConnection(deadline, watchdog, StdlibHttpsTransport.tls_context())
    assert (conn.host, conn.port) == (HOST, 443) and HOST == "api-free.deepl.com"
    assert conn._tls.verify_mode == ssl.CERT_REQUIRED and conn._tls.check_hostname
    assert conn._tunnel_host is None
    with pytest.raises(RuntimeError):
        conn.set_tunnel("proxy.invalid", 3128)


def test_connect_opens_a_watched_socket_and_wraps_it_for_the_fixed_host(monkeypatch):
    opened: list[FakeSocketForConnect] = []

    class FakeSocketForConnect(FakeSock):
        def __init__(self, *args) -> None:
            super().__init__()
            self.address = None
            opened.append(self)

        def connect(self, address) -> None:
            self.address = address

        def close(self) -> None:
            pass

    class FakeContext:
        verify_mode, check_hostname = ssl.CERT_REQUIRED, True

        def wrap_socket(self, raw, server_hostname=None):
            self.wrapped = (raw, server_hostname)
            return raw

    monkeypatch.setattr(socket, "socket", FakeSocketForConnect)
    clock = FakeClock()
    watchdog = Watchdog(BUDGET_SECONDS)
    context = FakeContext()
    conn = BoundedHTTPSConnection(
        Deadline(BUDGET_SECONDS, clock),
        watchdog,
        context,  # type: ignore[arg-type]
        resolver=lambda host, port, deadline: [(2, 1, 6, "", ("192.0.2.10", port))],
    )
    conn.connect()
    [raw] = opened
    assert raw.address == ("192.0.2.10", 443)
    assert raw.timeouts and all(0 < t <= BUDGET_SECONDS for t in raw.timeouts)
    assert context.wrapped == (raw, HOST)
    assert watchdog._sockets == [raw, raw]  # the raw socket and its TLS wrapper


def test_a_prompt_response_is_returned_and_the_connection_closed():
    clock = FakeClock()
    response = transport_with(clock).post(PATH, {"Content-Type": "application/json"}, b"{}")
    [conn] = FakeConnection.made
    assert response.status == 200 and b"Invented." in response.body
    assert conn.closed and conn.sent[0:2] == ("POST", PATH)


def test_reads_at_most_one_byte_past_the_size_limit():
    clock = FakeClock()
    big = [b"x" * READ_CHUNK_BYTES] * 20
    response = transport_with(clock, chunks=big).post(PATH, {}, b"{}")
    assert len(response.body) == MAX_RESPONSE_BYTES + 1


def test_a_slow_drip_body_cannot_outlast_the_budget():
    """1-byte chunks every 0.5 s: each read is far within any inactivity timeout."""
    clock = FakeClock()
    transport = transport_with(clock, chunks=[b"x"] * 100, chunk_delay=0.5)
    with pytest.raises(TimeoutError):
        transport.post(PATH, {}, b"{}")
    [conn] = FakeConnection.made
    assert conn.closed
    assert clock.now - 1000.0 <= BUDGET_SECONDS + 0.5  # stopped at the first read past it
    assert conn.sock.timeouts == sorted(conn.sock.timeouts, reverse=True)  # shrinking caps
    assert all(t <= BUDGET_SECONDS for t in conn.sock.timeouts)


def test_delayed_response_headers_exceed_the_budget():
    clock = FakeClock()
    with pytest.raises(TimeoutError):
        transport_with(clock, header_delay=BUDGET_SECONDS + 1).post(PATH, {}, b"{}")
    assert FakeConnection.made[0].closed


def test_a_response_completed_after_the_budget_is_discarded():
    clock = FakeClock()
    transport = transport_with(clock, chunk_delay=BUDGET_SECONDS / 2 + 0.1)
    with pytest.raises(TimeoutError):
        transport.post(PATH, {}, b"{}")


def test_the_watchdog_ends_a_blocked_read_in_real_time():
    """A read that never returns on its own: the watchdog's shutdown unblocks it."""

    class BlockingConnection(FakeConnection):
        def getresponse(self):
            if not self.sock.was_shut_down.wait(5):
                raise AssertionError("watchdog never fired")
            raise ConnectionResetError("socket shut down")

    FakeConnection.made.clear()
    transport = StdlibHttpsTransport(
        budget=0.2,
        connection_factory=lambda d, w, c: BlockingConnection(d, w, c, clock=FakeClock()),
    )
    started = time.monotonic()
    with pytest.raises(TimeoutError):
        transport.post(PATH, {}, b"{}")
    assert time.monotonic() - started < 3
    assert FakeConnection.made[0].closed and FakeConnection.made[0].watchdog.fired


def test_name_resolution_is_waited_for_at_most_the_budget(monkeypatch):
    release = threading.Event()

    def slow_getaddrinfo(*args, **kwargs):
        release.wait(5)
        return []

    monkeypatch.setattr(socket, "getaddrinfo", slow_getaddrinfo)
    started = time.monotonic()
    with pytest.raises(TimeoutError):
        resolve(HOST, 443, Deadline(0.1))
    assert time.monotonic() - started < 3
    release.set()


def test_the_owner_budget_is_below_the_joiner_wait():
    assert BUDGET_SECONDS == 15.0 and JOIN_TIMEOUT_SECONDS == 20.0


def deepl_world(world, clock, **options):
    """A World whose provider is the real DeepLClient over a fake connection."""
    transport = transport_with(clock, **options)
    return world(DeepLClient(SecretKey(SENTINEL), transport))  # type: ignore[arg-type]


def test_an_owner_timeout_releases_joiners_without_a_refund_retry_or_late_cache(world):
    clock, gate = FakeClock(), threading.Event()
    w = deepl_world(world, clock, gate=gate, header_delay=BUDGET_SECONDS + 1)
    w.add_episode()
    w.consent()

    def release_when_joined():
        wait_until(lambda: len(FakeConnection.made) == 1)
        time.sleep(0.2)  # let the other callers join the in-flight request
        gate.set()

    threading.Thread(target=release_when_joined).start()
    results = run_parallel(
        4, lambda _: w.service.translate("ep-aaaaaaaaaaaa", "seg-0001", SUBMITTED)
    )
    assert all(isinstance(r, TranslationError) for r in results)
    assert {r.code for r in results} == {"TRANSLATION_UNAVAILABLE"}
    assert len(FakeConnection.made) == 1 and FakeConnection.made[0].closed  # no retry
    assert w.service._flights == {}
    assert w.usage() == (1, len(SUBMITTED))  # reserved once, never refunded
    assert w.attempts() == [
        {
            "status": "failed",
            "failure_code": "TRANSLATION_UNAVAILABLE",
            "http_status": None,
            "characters": len(SUBMITTED),
        }
    ]
    assert w.cache_rows() == []  # nothing arrives late

    # A later, explicit request proceeds normally.
    w.provider._transport = transport_with(clock)
    later = w.post()
    assert later.status_code == 200 and later.json()["text"] == "Invented."
    assert w.usage()[0] == 2 and len(w.cache_rows()) == 1


def test_a_slow_drip_through_the_service_fails_safely(world):
    clock = FakeClock()
    w = deepl_world(world, clock, chunks=[b"x"] * 100, chunk_delay=0.5)
    w.add_episode()
    w.consent()
    response = w.post()
    assert response.status_code == 503
    assert response.json()["error"] == {
        "code": "TRANSLATION_UNAVAILABLE",
        "message": "Translation is unavailable right now. Try again later.",
    }
    assert w.cache_rows() == [] and w.usage()[0] == 1 and w.service._flights == {}


# --- Eligibility and text rules --------------------------------------------------------------


def test_one_line_is_translated_once_then_served_from_the_cache(world):
    w = world()
    w.add_episode()
    w.consent()
    first = w.post()
    assert first.status_code == 200, first.text
    body = first.json()
    assert parse_translation_result(body).ok
    assert (body["source"], body["text"], body["fingerprint"]) == (
        "provider",
        "EN<7>",
        fingerprint(SUBMITTED),
    )
    again = w.post()
    assert again.json()["source"] == "cache" and again.json()["text"] == "EN<7>"
    assert w.provider.calls == [SUBMITTED]
    assert w.usage() == (1, len(SUBMITTED))
    assert w.attempts() == [
        {"status": "succeeded", "failure_code": None, "http_status": 200, "characters": 7}
    ]


@pytest.mark.parametrize(
    ("setup", "code", "status"),
    [
        ({"kind": "mock"}, "TRANSLATION_NOT_ALLOWED", 409),
        ({"status": "running"}, "TRANSLATION_NOT_ALLOWED", 409),
        ({"status": "failed"}, "TRANSLATION_NOT_ALLOWED", 409),
    ],
    ids=["mock transcript", "incomplete job", "failed job"],
)
def test_ineligible_transcripts_are_refused(world, setup, code, status):
    w = world()
    w.add_episode(**setup)
    w.consent()
    response = w.post()
    assert response.status_code == status and response.json()["error"]["code"] == code
    assert w.provider.calls == [] and w.usage() == (0, 0)


def test_unknown_episode_and_segment(world):
    w = world()
    w.add_episode()
    w.consent()
    assert w.post(episode_id="ep-ffffffffffff").json()["error"]["code"] == "EPISODE_NOT_FOUND"
    assert w.post(segment_id="seg-9999").json()["error"]["code"] == "SEGMENT_NOT_FOUND"
    assert w.provider.calls == []


@pytest.mark.parametrize(
    "text",
    ["好" * 301, "OK", "café咖啡", "你好\n世界", "豈"],
    ids=["too long", "no Chinese", "not NFC", "control character", "compatibility ideograph"],
)
def test_invalid_text_is_refused_without_a_call(world, text):
    w = world()
    w.add_episode()
    w.consent()
    response = w.post(text)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "TRANSLATION_INVALID_TEXT"
    assert w.provider.calls == [] and w.usage() == (0, 0)


def test_off_and_consent_states_refuse_new_requests(world):
    off = world(PEBBLE_TRANSLATION_PROVIDER="")
    off.add_episode()
    assert off.post().json()["error"]["code"] == "TRANSLATION_OFF"
    on = world()
    on.add_episode()
    response = on.post()
    assert response.json()["error"]["code"] == "TRANSLATION_CONSENT_REQUIRED"
    assert on.provider.calls == [] and on.usage() == (0, 0) and on.attempts() == []


def test_cache_hits_need_no_consent_key_or_budget(tmp_path):
    first = World(tmp_path)
    first.add_episode()
    first.consent()
    assert first.post().json()["source"] == "provider"
    withdraw_consent(first.db)
    with first.db.tx() as conn:
        conn.execute("UPDATE translation_usage SET requests = 999999, characters = 999999")
    assert first.post().json()["source"] == "cache"
    first.close()
    # Same data, translation not set up at all (no provider, no key).
    later = World(tmp_path, PEBBLE_TRANSLATION_PROVIDER="", DEEPL_AUTH_KEY="")
    response = later.post()
    assert response.status_code == 200 and response.json()["source"] == "cache"
    assert later.provider.calls == []
    later.close()


def test_reverting_an_edit_reuses_its_earlier_translation(world):
    w = world()
    w.add_episode()
    w.consent()
    assert w.post(ORIGINAL).json()["source"] == "provider"
    assert w.post(SUBMITTED).json()["source"] == "provider"
    reverted = w.post(ORIGINAL).json()
    assert reverted["source"] == "cache" and reverted["fingerprint"] == fingerprint(ORIGINAL)
    assert w.provider.calls == [ORIGINAL, SUBMITTED]
    cached = w.client.get("/episodes/ep-aaaaaaaaaaaa/translations").json()
    assert parse_episode_translations(cached).ok
    assert [t["fingerprint"] for t in cached["translations"]] == [
        fingerprint(ORIGINAL),
        fingerprint(SUBMITTED),
    ]


# --- Concurrency -----------------------------------------------------------------------------


def run_parallel(n, fn):
    with ThreadPoolExecutor(n) as pool:
        futures = [pool.submit(fn, i) for i in range(n)]
        out = []
        for f in futures:
            try:
                out.append(f.result(timeout=30))
            except TranslationError as e:
                out.append(e)
        return out


def wait_until(condition, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.005)
    raise AssertionError("condition not reached")


def test_ten_identical_requests_make_one_reservation_and_one_call(world):
    gate = threading.Event()
    w = world(FakeProvider(gate=gate))
    w.add_episode()
    w.consent()

    def release_when_all_joined():
        w.provider.started.wait(10)
        time.sleep(0.2)  # give the other nine time to join the in-flight request
        gate.set()

    threading.Thread(target=release_when_all_joined).start()
    results = run_parallel(
        10, lambda _: w.service.translate("ep-aaaaaaaaaaaa", "seg-0001", SUBMITTED)
    )
    assert all(not isinstance(r, Exception) for r in results)
    assert {r.text for r in results} == {"EN<7>"}
    assert w.provider.calls == [SUBMITTED]
    assert w.usage() == (1, 7) and len(w.attempts()) == 1
    assert w.service._flights == {}


def test_distinct_requests_cannot_exceed_the_request_limit(world):
    w = world(
        FakeProvider(reply=lambda t: (time.sleep(0.05), "EN")[1]),
        PEBBLE_TRANSLATION_MONTHLY_REQUEST_LIMIT="3",
    )
    w.add_episode()
    w.consent()
    texts = [f"好{'句' * i}" for i in range(1, 9)]
    results = run_parallel(
        8, lambda i: w.service.translate("ep-aaaaaaaaaaaa", "seg-0001", texts[i])
    )
    ok = [r for r in results if not isinstance(r, Exception)]
    refused = [r for r in results if isinstance(r, TranslationError)]
    assert len(ok) == 3 and len(w.provider.calls) == 3
    assert {r.code for r in refused} == {"TRANSLATION_LOCAL_LIMIT"} and len(refused) == 5
    assert w.usage()[0] == 3


def test_distinct_requests_cannot_exceed_the_character_limit(world):
    w = world(PEBBLE_TRANSLATION_MONTHLY_CHARACTER_LIMIT="10")
    w.add_episode()
    w.consent()
    texts = [f"好好好{c}" for c in "一二三四五六"]  # 4 code points each
    results = run_parallel(
        6, lambda i: w.service.translate("ep-aaaaaaaaaaaa", "seg-0001", texts[i])
    )
    assert sum(not isinstance(r, Exception) for r in results) == 2
    assert w.usage() == (2, 8) and len(w.provider.calls) == 2


def test_consent_withdrawn_before_reservation_blocks_the_request(world, monkeypatch):
    w = world()
    w.add_episode()
    w.consent()
    original = w.service._cached
    calls = {"n": 0}

    def withdraw_on_recheck(*args):
        calls["n"] += 1
        if calls["n"] == 2:  # the owner's recheck, just before reserving
            withdraw_consent(w.db)
        return original(*args)

    monkeypatch.setattr(w.service, "_cached", withdraw_on_recheck)
    response = w.post()
    assert response.json()["error"]["code"] == "TRANSLATION_CONSENT_REQUIRED"
    assert w.provider.calls == [] and w.usage() == (0, 0) and w.attempts() == []


def test_a_reserved_request_completes_if_consent_is_withdrawn_meanwhile(world):
    w = world()
    w.add_episode()
    w.consent()

    def withdraw_then_reply(text):
        withdraw_consent(w.db)
        return "EN"

    w.provider.reply = withdraw_then_reply
    response = w.post()
    assert response.status_code == 200 and response.json()["source"] == "provider"
    assert len(w.cache_rows()) == 1 and w.attempts()[0]["status"] == "succeeded"
    assert w.post(OTHER).json()["error"]["code"] == "TRANSLATION_CONSENT_REQUIRED"
    assert w.post().json()["source"] == "cache"  # the stored result stays readable


def test_deleting_the_episode_during_a_request_never_recreates_its_cache(world):
    w = world()
    w.add_episode()
    w.consent()

    def delete_then_reply(text):
        with w.db.tx() as conn:
            conn.execute("DELETE FROM episodes WHERE id = 'ep-aaaaaaaaaaaa'")
        return "EN"

    w.provider.reply = delete_then_reply
    response = w.post()
    assert response.status_code == 404 and response.json()["error"]["code"] == "EPISODE_NOT_FOUND"
    assert w.cache_rows() == []
    assert w.usage() == (1, 7)  # the reservation is never refunded
    assert w.attempts()[0]["status"] == "succeeded"


def test_a_failure_releases_every_waiter_and_a_later_retry_works(world):
    gate = threading.Event()
    w = world(
        FakeProvider(reply=lambda t: ProviderFailure("TRANSLATION_UNAVAILABLE", 503), gate=gate)
    )
    w.add_episode()
    w.consent()

    def release():
        w.provider.started.wait(10)
        time.sleep(0.2)
        gate.set()

    threading.Thread(target=release).start()
    results = run_parallel(
        5, lambda _: w.service.translate("ep-aaaaaaaaaaaa", "seg-0001", SUBMITTED)
    )
    assert all(isinstance(r, TranslationError) for r in results)
    assert {r.code for r in results} == {"TRANSLATION_UNAVAILABLE"}
    assert len(w.provider.calls) == 1 and w.service._flights == {}
    assert w.attempts()[0] == {
        "status": "failed",
        "failure_code": "TRANSLATION_UNAVAILABLE",
        "http_status": 503,
        "characters": 7,
    }
    w.provider.gate = None
    w.provider.reply = lambda t: "EN"
    retry = w.post()  # an explicit retry: a new reservation and one new call
    assert retry.status_code == 200 and len(w.provider.calls) == 2 and w.usage()[0] == 2


def test_joined_requests_stop_waiting_after_the_join_timeout(world):
    gate = threading.Event()
    w = world(FakeProvider(gate=gate))
    w.add_episode()
    w.consent()
    w.service.join_timeout = 0.2
    owner = threading.Thread(
        target=lambda: w.service.translate("ep-aaaaaaaaaaaa", "seg-0001", SUBMITTED)
    )
    owner.start()
    w.provider.started.wait(10)
    started = time.monotonic()
    with pytest.raises(TranslationError) as failure:
        w.service.translate("ep-aaaaaaaaaaaa", "seg-0001", SUBMITTED)
    assert failure.value.code == "TRANSLATION_UNAVAILABLE"
    assert time.monotonic() - started < 5
    gate.set()
    owner.join(10)
    assert w.service._flights == {} and len(w.provider.calls) == 1


def test_an_unexpected_owner_error_surfaces_but_still_releases_waiters(world):
    gate = threading.Event()
    w = world(FakeProvider(reply=lambda t: RuntimeError("invented bug"), gate=gate))
    w.add_episode()
    w.consent()

    def release():
        w.provider.started.wait(10)
        time.sleep(0.2)
        gate.set()

    threading.Thread(target=release).start()
    with ThreadPoolExecutor(4) as pool:
        futures = [
            pool.submit(w.service.translate, "ep-aaaaaaaaaaaa", "seg-0001", SUBMITTED)
            for _ in range(4)
        ]
        outcomes = []
        for f in futures:
            try:
                outcomes.append(f.result(timeout=30))
            except Exception as e:  # collecting every outcome
                outcomes.append(e)
    bugs = [o for o in outcomes if isinstance(o, RuntimeError)]
    safe = [o for o in outcomes if isinstance(o, TranslationError)]
    assert len(bugs) == 1  # the owner: the bug isn't hidden
    assert len(safe) == 3 and {o.code for o in safe} == {"TRANSLATION_UNAVAILABLE"}
    assert w.service._flights == {} and len(w.provider.calls) == 1
    assert w.attempts()[0]["status"] == "failed" and w.cache_rows() == []


def test_two_episodes_share_limits_but_own_their_caches(world):
    w = world(PEBBLE_TRANSLATION_MONTHLY_REQUEST_LIMIT="2")
    a, b = w.add_episode("ep-aaaaaaaaaaaa"), w.add_episode("ep-bbbbbbbbbbbb")
    w.consent()
    assert w.post(episode_id=a).json()["source"] == "provider"
    assert w.post(episode_id=b).json()["source"] == "provider"
    limited = w.post(OTHER, episode_id=b, segment_id="seg-0002")
    assert limited.json()["error"]["code"] == "TRANSLATION_LOCAL_LIMIT"  # shared budget
    with w.db.tx() as conn:
        conn.execute("DELETE FROM episodes WHERE id = ?", (a,))
    assert w.cache_rows(a) == [] and len(w.cache_rows(b)) == 1
    assert w.post(episode_id=b).json()["source"] == "cache"
    assert w.client.get(f"/episodes/{a}/translations").status_code == 404
    assert len(w.client.get(f"/episodes/{b}/translations").json()["translations"]) == 1


def test_startup_marks_leftover_reservations_unknown_without_calling_deepl(tmp_path):
    first = World(tmp_path)
    with first.db.tx() as conn:
        conn.execute(
            "INSERT INTO translation_attempts (id, period, characters, consent_version, status, "
            "created_at, updated_at) VALUES ('a1', '2026-10', 7, ?, 'reserved', 'x', 'x')",
            (CONSENT_VERSION,),
        )
        conn.execute("INSERT INTO translation_usage VALUES ('2026-10', 1, 7)")
    first.close()
    second = World(tmp_path)
    assert second.attempts()[0]["status"] == "unknown"
    assert second.usage() == (1, 7) and second.provider.calls == []
    second.close()


# --- Routes ----------------------------------------------------------------------------------


def test_cache_retrieval_never_calls_deepl(world):
    w = world(FakeProvider(reply=lambda t: AssertionError("must not be called")))
    w.add_episode()
    with w.db.tx() as conn:
        conn.execute(
            "INSERT INTO translations VALUES ('ep-aaaaaaaaaaaa', 'seg-0001', ?, 'deepl', 'EN-US', "
            "1, 7, 'Cached.', '2026-10-06T00:00:00Z')",
            (fingerprint(SUBMITTED),),
        )
    response = w.client.get("/episodes/ep-aaaaaaaaaaaa/translations", headers={"origin": ORIGIN})
    assert response.status_code == 200 and w.provider.calls == []
    assert response.json()["translations"][0]["text"] == "Cached."
    assert w.client.get("/episodes/ep-ffffffffffff/translations").status_code == 404


def test_translation_routes_keep_the_security_checks(world):
    w = world()
    w.add_episode()
    w.consent()
    assert w.post(origin="https://example.com").status_code == 403
    assert w.post(host="evil.example").status_code == 400
    assert (
        w.client.get(
            "/episodes/ep-aaaaaaaaaaaa/translations", headers={"origin": "https://example.com"}
        ).status_code
        == 403
    )
    wrong_type = w.client.post(
        "/translations", content=b"{}", headers={"content-type": "text/plain"}
    )
    assert wrong_type.status_code == 415
    big = json.dumps({"schemaVersion": "1.8", "pad": "x" * 5000}).encode()
    too_large = w.client.post(
        "/translations", content=big, headers={"content-type": "application/json"}
    )
    assert too_large.status_code == 413
    preflight = w.client.options(
        "/translations", headers={"origin": ORIGIN, "access-control-request-method": "POST"}
    )
    assert preflight.status_code == 200
    assert w.provider.calls == []


def test_malformed_translation_requests(world):
    w = world()
    w.add_episode()
    w.consent()
    bodies = (
        {"schemaVersion": "1.8"},
        {"schemaVersion": "1.8", "episodeId": "ep-aaaaaaaaaaaa", "segmentId": "seg-0001"},
        {
            "schemaVersion": "1.8",
            "episodeId": "ep-aaaaaaaaaaaa",
            "segmentId": "seg-0001",
            "text": 5,
        },
        {
            "schemaVersion": "2.0",
            "episodeId": "ep-aaaaaaaaaaaa",
            "segmentId": "seg-0001",
            "text": "好",
        },
        [],
        "x",
    )
    for body in bodies:
        response = w.client.post(
            "/translations",
            content=json.dumps(body).encode(),
            headers={"content-type": "application/json"},
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "INVALID_REQUEST"
    assert w.provider.calls == []


# --- Health ----------------------------------------------------------------------------------


def test_health_reports_readiness_and_the_local_limit(world):
    w = world(PEBBLE_TRANSLATION_MONTHLY_REQUEST_LIMIT="1")
    w.add_episode()
    health = w.client.get("/health").json()
    assert health["schemaVersion"] == "1.8" and parse_worker_health(health).ok
    assert health["translation"]["newRequests"] == "consent_required"
    w.consent()
    assert w.client.get("/health").json()["translation"]["newRequests"] == "available"
    w.post()
    after = w.client.get("/health").json()["translation"]
    assert after["newRequests"] == "local_limit_reached"
    assert (after["limits"]["requestsUsed"], after["limits"]["requestLimit"]) == (1, 1)


# --- Nothing private escapes ----------------------------------------------------------------


def test_no_key_source_text_or_provider_text_in_responses_logs_or_storage(world, caplog):
    caplog.set_level(logging.DEBUG)
    replies = iter(
        [
            ENGLISH,
            ProviderFailure("TRANSLATION_UNAVAILABLE", 500),
            ProviderFailure("TRANSLATION_KEY_REJECTED", 403),
        ]
    )
    w = world(FakeProvider(reply=lambda t: next(replies)))
    w.add_episode()
    w.consent()
    responses = [
        w.client.get("/health"),
        w.post(),  # provider
        w.post(),  # cache
        w.post(OTHER, segment_id="seg-0002"),  # provider failure
        w.post("你们好。", segment_id="seg-0002"),  # key rejected
        w.post("好" * 301),  # invalid text
        w.client.get("/episodes/ep-aaaaaaaaaaaa/translations"),
    ]
    for response in responses:
        for secret in (SENTINEL, SUBMITTED, "你们好", RAW_PROVIDER):
            assert secret not in response.text, (secret, response.status_code)
        assert all(SENTINEL not in v for v in response.headers.values())
    # English appears only in its translation fields.
    assert responses[1].json()["text"] == ENGLISH and responses[2].json()["text"] == ENGLISH
    for response in responses:
        if response not in (responses[1], responses[2], responses[6]):
            assert ENGLISH not in response.text
    for secret in (SENTINEL, SUBMITTED, OTHER, "你们好", RAW_PROVIDER, ENGLISH):
        assert secret not in caplog.text
    data = w.app.state.storage.root
    conn = sqlite3.connect(data / "pebble.db")
    try:
        for (table,) in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'"):
            dumped = repr(conn.execute(f"SELECT * FROM {table}").fetchall())
            for secret in (SENTINEL, SUBMITTED, "你们好", RAW_PROVIDER):
                assert secret not in dumped, (table, secret)
            if table != "translations":
                assert ENGLISH not in dumped, table
    finally:
        conn.close()
    for path in data.rglob("*"):
        if path.is_file() and not path.name.startswith("pebble.db"):
            raw = path.read_bytes()
            for secret in (SENTINEL, SUBMITTED, RAW_PROVIDER, ENGLISH):
                assert secret.encode() not in raw, path.name


def test_health_still_answers_when_the_data_folder_is_unwritable(world):
    w = world()
    root = w.app.state.storage.root
    root.chmod(0o500)
    try:
        response = w.client.get("/health")
    finally:
        root.chmod(0o700)
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded" and "translation" not in body
    assert parse_worker_health(body).ok


def test_the_documented_error_table_matches_the_worker_exactly():
    from conftest import REPO

    from pebble_worker.translation.service import ERRORS

    text = (REPO / "docs" / "TRANSLATION.md").read_text()
    section = text[text.index("## Errors") : text.index("## Testing")]
    documented = {}
    for line in section.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) == 4 and cells[1].startswith("`"):
            documented[cells[1].strip("`")] = (int(cells[2]), cells[3])
    assert documented == ERRORS


def test_raw_provider_responses_never_reach_routes_logs_or_storage(world, caplog):
    """The real DeepLClient over a fake transport whose error bodies carry provider text."""
    caplog.set_level(logging.DEBUG)

    class ScriptedTransport:
        def __init__(self):
            self.replies = [
                TransportResponse(500, RAW_PROVIDER.encode()),
                TransportResponse(403, json.dumps({"message": RAW_PROVIDER}).encode()),
                TransportResponse(200, json.dumps({"translations": [{"text": ENGLISH}]}).encode()),
            ]

        def post(self, path, headers, body):
            return self.replies.pop(0)

    w = world(DeepLClient(SecretKey(SENTINEL), ScriptedTransport()))  # type: ignore[arg-type]
    w.add_episode()
    w.consent()
    responses = [w.post(), w.post(OTHER, segment_id="seg-0002"), w.post()]
    assert [r.status_code for r in responses] == [503, 502, 200]
    for response in responses:
        assert RAW_PROVIDER not in response.text and SENTINEL not in response.text
    assert RAW_PROVIDER not in caplog.text and SENTINEL not in caplog.text
    conn = sqlite3.connect(w.app.state.storage.root / "pebble.db")
    try:
        for (table,) in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'"):
            dumped = repr(conn.execute(f"SELECT * FROM {table}").fetchall())
            assert RAW_PROVIDER not in dumped and SENTINEL not in dumped, table
    finally:
        conn.close()
    assert w.attempts()[1]["http_status"] == 403
