"""
Speaker routes, scheduling and lifecycle (ADR 0009, contract 1.9) through the real app and an
in-process TestClient (no sockets): temporary databases, invented transcripts, fake execution,
model-state and isolation adapters. No model loads and no child process starts.
"""

from __future__ import annotations

import json
import threading
import time
import wave
from collections.abc import Callable
from pathlib import Path

import pytest
from conftest import TEST_CHUNKING, WORKER_URL
from fastapi.testclient import TestClient

from pebble_worker.api import create_app
from pebble_worker.config import Settings
from pebble_worker.contract import (
    CURRENT_SCHEMA_VERSION,
    parse_episode_speakers,
    parse_worker_health,
)
from pebble_worker.db import Database
from pebble_worker.jobs import JobRunner
from pebble_worker.speakers.core import DiarizationResult, Speaker
from pebble_worker.speakers.service import SpeakerWork
from pebble_worker.speakers.store import SpeakerStore
from pebble_worker.storage import Storage

EPISODE = "ep-0123456789ab"
OTHER = "ep-ba9876543210"
STAMP = "2026-10-07T00:00:00.000Z"
NAME = "Ms Example Person"  # invented; must never be echoed in an error


def seed(
    db: Database, storage: Storage, episode: str, *, kind: str = "asr", job: str = "completed"
):
    segments = [
        {"id": f"seg-{i + 1:04d}", "startMs": i * 2000, "endMs": i * 2000 + 1500, "text": "虚构"}
        for i in range(4)
    ]
    body = {"schemaVersion": "1.8", "segments": segments, "provenance": {"kind": kind}}
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO episodes VALUES "
            "(?, 'Invented', 'x.wav', ?, 'audio/wav', 8000, 'zh-CN', ?, ?)",
            (episode, f"episodes/{episode}/source.wav", STAMP, STAMP),
        )
        conn.execute(
            """INSERT INTO jobs (id, episode_id, status, attempt, provider_id, provider_kind,
                                 created_at, updated_at)
               VALUES (?, ?, ?, 1, 'funasr', 'asr', ?, ?)""",
            (f"job-{episode[3:]}", episode, job, STAMP, STAMP),
        )
        conn.execute(
            "INSERT INTO transcripts VALUES (?, ?, 1, ?, ?)",
            (episode, f"job-{episode[3:]}", json.dumps(body, ensure_ascii=False), STAMP),
        )
    directory = storage.episode_dir(episode)
    (directory / "work").mkdir(parents=True)
    with wave.open(str(directory / "source.wav"), "wb") as out:
        out.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        out.writeframes(b"\x00\x00" * 16000 * 8)


def complete_with_two_speakers(db: Database, storage: Storage, settings: Settings, run_id: str):
    store = SpeakerStore(db)
    if not store.start(run_id):
        return "gone"
    speakers = ("S1", "S2", "S1", "S2")
    result = DiarizationResult(
        assignments={f"seg-{i + 1:04d}": s for i, s in enumerate(speakers)},
        speakers=(Speaker("S1", 2, 6), Speaker("S2", 2, 6)),
        windows=12,
        noise_windows=0,
        unassigned_lines=0,
        clustering="fake",
    )
    return store.complete(run_id, result)


class World:
    def __init__(
        self, tmp_path: Path, *, model: str = "ready", isolated: bool = True, execute=None
    ):
        self.settings = Settings(
            data_dir=tmp_path / "pebble", chunking=TEST_CHUNKING, mock_delay_ms=0
        )
        self.storage = Storage(self.settings.data_dir)
        self.storage.ensure()
        self.db = Database(self.storage.db_path)
        self.db.migrate()
        self.model_calls = 0
        self.model = model
        self.executed: list[str] = []

        def model_state() -> str:
            self.model_calls += 1
            return self.model

        def run(db, storage, settings, run_id):
            self.executed.append(run_id)
            return (execute or complete_with_two_speakers)(db, storage, settings, run_id)

        self.work = SpeakerWork(
            self.db,
            self.storage,
            self.settings,
            execute=run,
            model_state=model_state,
            isolation_available=lambda: isolated,
        )
        self.clients: list[TestClient] = []

    def client(self, *, start_runner: bool = False) -> TestClient:
        app = create_app(self.settings, start_runner=start_runner, speakers=self.work)
        client = TestClient(app, base_url=WORKER_URL)
        client.__enter__()
        self.clients.append(client)
        return client

    def close(self) -> None:
        for client in self.clients:
            client.__exit__(None, None, None)

    def rows(self, table: str) -> list[tuple]:
        with self.db.tx() as conn:
            return [tuple(r) for r in conn.execute(f"SELECT * FROM {table} ORDER BY rowid")]


@pytest.fixture
def world(tmp_path) -> Callable[..., World]:
    made: list[World] = []

    def make(**kwargs) -> World:
        w = World(tmp_path / f"w{len(made)}", **kwargs)
        seed(w.db, w.storage, EPISODE)
        made.append(w)
        return w

    yield make
    for w in made:
        w.close()


def start(client: TestClient, episode: str = EPISODE, body: object | None = None, **kw):
    payload = {"schemaVersion": "1.9"} if body is None else body
    return client.post(f"/episodes/{episode}/speakers", json=payload, **kw)


def corrections(run_id: str, revision: int, **fields) -> dict:
    return {
        "schemaVersion": "1.9",
        "episodeId": EPISODE,
        "runId": run_id,
        "revision": revision,
        "names": {},
        "merges": {},
        "notSpeaker": [],
        "lines": {},
        **fields,
    }


def wait_for(predicate, timeout: float = 10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if value := predicate():
            return value
        time.sleep(0.02)
    raise AssertionError("condition not reached")


# --- POST ---------------------------------------------------------------------------------------


def test_post_claims_work_without_running_it_in_the_request(world):
    w = world()
    client = w.client()  # runner not started: nothing executes
    response = start(client, body={"schemaVersion": "1.9", "speakerCount": 2})
    assert response.status_code == 202
    body = response.json()
    assert (
        parse_episode_speakers(body).ok and body["schemaVersion"] == CURRENT_SCHEMA_VERSION == "1.9"
    )
    assert body["current"] is None and body["latest"]["status"] == "queued"
    assert w.executed == [] and w.model_calls == 1  # a file-presence check, nothing more
    with w.db.tx() as conn:
        assert conn.execute("SELECT speaker_hint FROM speaker_runs").fetchone()[0] == 2


def test_runner_executes_queued_work_and_get_separates_current_from_latest(world):
    w = world()
    client = w.client(start_runner=True)
    assert start(client).status_code == 202
    body = wait_for(
        lambda: (b := client.get(f"/episodes/{EPISODE}/speakers").json())["current"] and b
    )
    assert body["current"]["effective"]["seg-0002"] == "S2"
    assert body["latest"]["runId"] == body["current"]["runId"]
    # A re-detection that fails keeps the previous success as current.
    w2_run = w.work.store.create_run(EPISODE)
    w.work.store.start(w2_run)
    w.work.store.fail(w2_run, "CLUSTERING_FAILED")
    again = client.get(f"/episodes/{EPISODE}/speakers").json()
    assert again["current"]["runId"] == body["current"]["runId"]
    assert again["latest"]["failure"]["code"] == "CLUSTERING_FAILED"


def test_get_is_side_effect_free(world):
    w = world()
    client = w.client()
    start(client)
    before = (w.rows("speaker_runs"), w.model_calls, list(w.executed))
    for _ in range(3):
        assert client.get(f"/episodes/{EPISODE}/speakers").status_code == 200
    assert (w.rows("speaker_runs"), w.model_calls, list(w.executed)) == before
    assert client.get("/episodes/ep-ffffffffffff/speakers").status_code == 404


@pytest.mark.parametrize(
    ("body", "status", "code"),
    [
        ({"schemaVersion": "1.9", "speakerCount": 0}, 422, "INVALID_REQUEST"),
        ({"schemaVersion": "1.9", "speakerCount": 16}, 422, "INVALID_REQUEST"),
        ({"schemaVersion": "2.0"}, 422, "INVALID_REQUEST"),
        ([], 422, "INVALID_REQUEST"),
    ],
)
def test_post_validates_the_request(world, body, status, code):
    w = world()
    response = start(w.client(), body=body)
    assert (response.status_code, response.json()["error"]["code"]) == (status, code)
    assert w.rows("speaker_runs") == []


def test_post_body_rules(world):
    w = world()
    client = w.client()
    url = f"/episodes/{EPISODE}/speakers"
    dup = b'{"schemaVersion": "1.9", "speakerCount": 2, "speakerCount": 3}'
    r = client.post(url, content=dup, headers={"Content-Type": "application/json"})
    assert (r.status_code, r.json()["error"]["code"]) == (422, "DUPLICATE_KEYS")
    r = client.post(url, content=b"{}", headers={"Content-Type": "text/plain"})
    assert r.status_code == 415
    big = json.dumps({"schemaVersion": "1.9", "pad": "x" * 2000}).encode()
    r = client.post(url, content=big, headers={"Content-Type": "application/json"})
    assert (r.status_code, r.json()["error"]["code"]) == (413, "REQUEST_TOO_LARGE")
    assert w.rows("speaker_runs") == []


def test_post_refuses_ineligible_or_unavailable_inputs_with_fixed_errors(world, tmp_path):
    w = world()
    seed(w.db, w.storage, OTHER, kind="mock")
    client = w.client()
    assert start(client, OTHER).json()["error"]["code"] == "SPEAKERS_NOT_ELIGIBLE"
    assert start(client, "ep-ffffffffffff").status_code == 404
    assert start(client, "../etc").status_code == 404

    pending = world()
    with pending.db.tx() as conn:
        conn.execute("UPDATE jobs SET status = 'running'")
    assert start(pending.client()).json()["error"]["code"] == "EPISODE_NOT_READY"

    no_audio = world()
    (no_audio.storage.episode_dir(EPISODE) / "source.wav").unlink()
    r = start(no_audio.client())
    assert (r.status_code, r.json()["error"]["code"]) == (409, "AUDIO_UNAVAILABLE")

    missing = world(model="missing")
    r = start(missing.client())
    assert (r.status_code, r.json()["error"]["code"]) == (503, "SPEAKER_MODEL_UNAVAILABLE")
    assert "--speaker" in r.json()["error"]["hint"]

    sandboxless = world(isolated=False)
    r = start(sandboxless.client())
    assert (r.status_code, r.json()["error"]["code"]) == (503, "SPEAKER_ISOLATION_UNAVAILABLE")
    for each in (w, pending, no_audio, missing, sandboxless):
        assert each.rows("speaker_runs") == []


def test_only_one_active_run_even_under_concurrent_posts(world):
    w = world()
    client = w.client()
    statuses: list[int] = []
    barrier = threading.Barrier(8)

    def post():
        barrier.wait()
        statuses.append(start(client).status_code)

    threads = [threading.Thread(target=post) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(statuses) == [202] + [409] * 7
    assert len(w.rows("speaker_runs")) == 1
    assert start(client).json()["error"]["code"] == "SPEAKER_RUN_ACTIVE"


# --- PUT corrections ----------------------------------------------------------------------------


def completed_run(w: World, client: TestClient) -> str:
    start(client)
    run_id = w.work.store.queued_runs()[0]
    assert complete_with_two_speakers(w.db, w.storage, w.settings, run_id) == "completed"
    return run_id


def put(client: TestClient, body, **kw):
    return client.put(f"/episodes/{EPISODE}/speakers/corrections", json=body, **kw)


def test_corrections_use_revisions_and_refuse_stale_edits(world):
    w = world()
    client = w.client()
    run_id = completed_run(w, client)
    r = put(client, corrections(run_id, 0, names={"S1": NAME}, notSpeaker=["S2"]))
    assert r.status_code == 200
    assert r.json()["current"]["corrections"]["revision"] == 1
    assert r.json()["current"]["effective"]["seg-0002"] is None
    assert r.json()["current"]["assignments"]["seg-0002"] == "S2"  # original kept
    stale = put(client, corrections(run_id, 0, names={"S1": "Other"}))
    assert (stale.status_code, stale.json()["error"]["code"]) == (409, "SPEAKER_CORRECTIONS_STALE")
    assert client.get(f"/episodes/{EPISODE}/speakers").json()["current"]["corrections"][
        "names"
    ] == {"S1": NAME}
    assert (
        put(client, corrections(run_id, 1, names={})).json()["current"]["corrections"]["revision"]
        == 2
    )


def test_concurrent_corrections_on_one_revision_let_exactly_one_win(world):
    w = world()
    client = w.client()
    run_id = completed_run(w, client)
    statuses: list[int] = []
    barrier = threading.Barrier(6)

    def edit(n: int):
        barrier.wait()
        statuses.append(put(client, corrections(run_id, 0, names={"S1": f"Name {n}"})).status_code)

    threads = [threading.Thread(target=edit, args=(n,)) for n in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(statuses) == [200] + [409] * 5


def test_correction_errors_are_fixed_and_never_echo_names(world):
    w = world()
    client = w.client()
    run_id = completed_run(w, client)
    cases = [
        (corrections(run_id, 0, names={"S1": NAME * 5}), 422, "SPEAKER_CORRECTIONS_INVALID"),
        (corrections(run_id, 0, names={"S9": NAME}), 422, "SPEAKER_CORRECTIONS_INVALID"),
        (
            corrections(run_id, 0, merges={"S1": "S2", "S2": "S1"}),
            422,
            "SPEAKER_CORRECTIONS_INVALID",
        ),
        ({**corrections(run_id, 0), "episodeId": OTHER}, 422, "SPEAKER_CORRECTIONS_INVALID"),
        (corrections("spk-ffffffffffff", 0, names={"S1": NAME}), 409, "SPEAKER_RUN_MISMATCH"),
    ]
    for body, status, code in cases:
        r = put(client, body)
        assert (r.status_code, r.json()["error"]["code"]) == (status, code), body
        assert "Example" not in r.text and "fields" not in r.json()["error"]


def test_correction_bodies_are_limited_by_actual_bytes_and_unique_keys(world):
    w = world()
    client = w.client()
    run_id = completed_run(w, client)
    url = f"/episodes/{EPISODE}/speakers/corrections"
    headers = {"Content-Type": "application/json"}
    lines = {f"seg-{i:05d}": "S1" for i in range(60000)}
    big = json.dumps(corrections(run_id, 0, lines=lines)).encode()
    assert len(big) > 1024 * 1024
    r = client.put(url, content=big, headers=headers)
    assert (r.status_code, r.json()["error"]["code"]) == (413, "REQUEST_TOO_LARGE")
    small = json.dumps(corrections(run_id, 0)).encode()
    lying = client.put(
        url, content=small + b" " * 100, headers={**headers, "Content-Length": str(len(small))}
    )
    assert (lying.status_code, lying.json()["error"]["code"]) == (400, "INVALID_LENGTH")
    dup = small[:-1] + b', "revision": 5}'
    r = client.put(url, content=dup, headers=headers)
    assert (r.status_code, r.json()["error"]["code"]) == (422, "DUPLICATE_KEYS")
    assert w.rows("speaker_corrections") == []


# --- cancellation -------------------------------------------------------------------------------


def cancel(client: TestClient, run_id: str, episode: str = EPISODE):
    return client.post(f"/episodes/{episode}/speakers/runs/{run_id}/cancel")


def test_cancel_targets_one_run_is_idempotent_and_keeps_the_previous_success(world):
    w = world()
    client = w.client()
    done = completed_run(w, client)
    start(client)
    queued = w.work.store.queued_runs()[0]
    r = cancel(client, queued)
    assert r.status_code == 200 and r.json()["latest"]["status"] == "cancelled"
    assert r.json()["current"]["runId"] == done
    assert cancel(client, queued).json()["latest"]["status"] == "cancelled"  # idempotent
    # A late cancel for an old run never touches a newer one.
    start(client)
    newer = w.work.store.queued_runs()[0]
    assert cancel(client, queued).status_code == 200
    assert cancel(client, done).json()["latest"]["runId"] == newer
    assert w.work.store.queued_runs() == [newer]
    assert cancel(client, "spk-ffffffffffff").status_code == 404
    assert cancel(client, "not-a-run").status_code == 404
    seed(w.db, w.storage, OTHER)
    assert cancel(client, newer, episode=OTHER).status_code == 404  # wrong episode


def test_cancelling_a_running_run_stops_it_through_the_database(world):
    entered = threading.Event()

    def slow(db, storage, settings, run_id):
        store = SpeakerStore(db)
        store.start(run_id)
        entered.set()
        wait_for(lambda: not store.is_running(run_id))  # what execute_run's polling does
        return store.complete(run_id, DiarizationResult({}, (), 0, 0, 0, "fake"))

    w = world(execute=slow)
    client = w.client(start_runner=True)
    start(client)
    assert entered.wait(10)
    run_id = client.get(f"/episodes/{EPISODE}/speakers").json()["latest"]["runId"]
    assert cancel(client, run_id).json()["latest"]["status"] == "cancelled"
    wait_for(lambda: w.executed)
    time.sleep(0.2)
    body = client.get(f"/episodes/{EPISODE}/speakers").json()
    assert (
        body["latest"]["status"] == "cancelled" and body["current"] is None
    )  # late result dropped


# --- deletion -----------------------------------------------------------------------------------


def test_deleting_an_episode_cancels_speaker_work_and_leaves_nothing(world):
    entered = threading.Event()
    outcome: list[str] = []

    def slow(db, storage, settings, run_id):
        store = SpeakerStore(db)
        store.start(run_id)
        entered.set()
        wait_for(lambda: not store.is_running(run_id))
        outcome.append(store.complete(run_id, DiarizationResult({}, (), 0, 0, 0, "fake")))
        return "done"

    w = world(execute=slow)
    seed(w.db, w.storage, OTHER)
    client = w.client(start_runner=True)
    start(client)
    start(client, OTHER)  # queued behind the first
    assert entered.wait(10)
    assert client.delete(f"/episodes/{EPISODE}").status_code == 204
    wait_for(lambda: outcome)
    assert outcome == ["discarded"]
    assert not w.storage.episode_dir(EPISODE).exists()
    with w.db.tx() as conn:
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM speaker_runs WHERE episode_id = ?", (EPISODE,)
            ).fetchone()[0]
            == 0
        )
    # The runner survived and goes on to the other episode's queued run.
    wait_for(lambda: len(w.executed) == 2)
    assert client.get("/health").status_code == 200


def test_deleting_with_queued_speaker_work_never_starts_it(world):
    w = world()
    client = w.client()
    start(client)
    assert client.delete(f"/episodes/{EPISODE}").status_code == 204
    assert w.rows("speaker_runs") == []
    assert w.work.store.queued_runs() == []


# --- security and health ------------------------------------------------------------------------


def test_speaker_routes_keep_the_host_origin_and_cors_rules(world):
    w = world()
    client = w.client()
    evil = start(client, headers={"Origin": "https://example.invalid"})
    assert (evil.status_code, evil.json()["error"]["code"]) == (403, "ORIGIN_NOT_ALLOWED")
    cross = client.get(f"/episodes/{EPISODE}/speakers", headers={"Sec-Fetch-Site": "cross-site"})
    assert cross.status_code == 403
    host = TestClient(client.app, base_url="http://evil.invalid:8790")
    assert host.get(f"/episodes/{EPISODE}/speakers").status_code == 400
    allowed = w.settings.allowed_origins[0]
    preflight = client.options(
        f"/episodes/{EPISODE}/speakers/corrections",
        headers={"Origin": allowed, "Access-Control-Request-Method": "PUT"},
    )
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == allowed
    assert w.rows("speaker_runs") == []


@pytest.mark.parametrize(
    ("model", "isolated", "state"),
    [
        ("ready", True, "ready"),
        ("missing", True, "model_missing"),
        ("incomplete", True, "model_incomplete"),
        ("ready", False, "isolation_unavailable"),
    ],
)
def test_health_reports_speakers_without_degrading_the_worker(world, model, isolated, state):
    w = world(model=model, isolated=isolated)
    health = w.client().get("/health").json()
    assert parse_worker_health(health).ok and health["schemaVersion"] == "1.9"
    assert health["speakers"]["state"] == state
    baseline = world()
    assert health["status"] == baseline.client().get("/health").json()["status"]
    assert w.executed == []


def test_old_health_without_speakers_still_parses():
    from conftest import EXAMPLES

    old = json.loads((EXAMPLES / "valid" / "worker-health-translation.json").read_text())
    assert "speakers" not in old and parse_worker_health(old).ok


# --- scheduling and recovery --------------------------------------------------------------------


class FakeService:
    def __init__(self, queued: list[str]) -> None:
        self.queued = queued

    def recover_interrupted(self) -> list[str]:
        return []

    def queued_ids(self) -> list[str]:
        return list(self.queued)


class FakePipeline:
    def __init__(self, log: list[str], queued: list[str]) -> None:
        self.log = log
        self.service = FakeService(queued)

    def run(self, job_id: str) -> None:
        self.log.append(job_id)


class FakeSpeakers:
    def __init__(self, log: list[str], queued: list[str], on_run=None) -> None:
        self.log = log
        self.queued = queued
        self.on_run = on_run

    def recover(self) -> list[str]:
        return list(self.queued)

    def run(self, run_id: str) -> str:
        self.log.append(run_id)
        if self.on_run:
            self.on_run(run_id)
        return "completed"


def test_waiting_transcription_jobs_go_before_the_next_speaker_run():
    log: list[str] = []
    runner: JobRunner

    def on_run(run_id: str) -> None:
        if run_id == "spk-1":
            runner.submit("job-2")  # arrives while a speaker run is going

    runner = JobRunner(FakePipeline(log, ["job-1"]), FakeSpeakers(log, ["spk-1", "spk-2"], on_run))
    runner.start()
    wait_for(lambda: len(log) == 4)
    runner.stop()
    assert log == ["job-1", "spk-1", "job-2", "spk-2"]


def test_stop_drains_jobs_but_starts_no_new_speaker_run():
    log: list[str] = []
    gate = threading.Event()

    def on_run(run_id: str) -> None:
        gate.wait(5)

    runner = JobRunner(FakePipeline(log, []), FakeSpeakers(log, ["spk-1", "spk-2"], on_run))
    runner.start()
    wait_for(lambda: log == ["spk-1"])
    runner.submit("job-1")
    stopper = threading.Thread(target=runner.stop)
    stopper.start()
    time.sleep(0.1)
    gate.set()
    stopper.join(10)
    assert log == ["spk-1", "job-1"]  # spk-2 stays queued for the next start


def test_restart_recovers_and_allows_an_explicit_new_run(world):
    w = world()
    seed(w.db, w.storage, OTHER)
    interrupted = w.work.store.create_run(EPISODE)
    w.work.store.start(interrupted)
    queued = w.work.store.create_run(OTHER)
    client = w.client(start_runner=True)  # startup: recover, then resume queued
    wait_for(lambda: w.executed == [queued])
    body = client.get(f"/episodes/{EPISODE}/speakers").json()
    assert body["latest"]["failure"]["code"] == "WORKER_RESTARTED"
    assert interrupted not in w.executed  # never re-run silently
    assert start(client).status_code == 202  # an explicit new run is allowed
    # `executed` is recorded before the fake finishes, so wait for the result itself.
    wait_for(lambda: client.get(f"/episodes/{EPISODE}/speakers").json()["current"])
    assert len(w.executed) == 2


def test_no_speaker_run_is_created_by_transcription(world):
    w = world()
    w.client(start_runner=True)
    time.sleep(0.2)
    assert w.rows("speaker_runs") == [] and w.executed == []
