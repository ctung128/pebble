"""
The speaker child process and its parent (ADR 0009): fake child scripts written here, the real
child entry point without a model, temporary databases and invented audio. No model loads, no
socket is used, nothing outside the temporary folders is written.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import textwrap
import time
import wave
from pathlib import Path

import pytest
from test_speaker_store import EPISODE, OTHER, completed, seed

from pebble_worker.config import Settings
from pebble_worker.db import Database
from pebble_worker.speakers import runner
from pebble_worker.speakers.core import LineSpan
from pebble_worker.speakers.store import SpeakerStore
from pebble_worker.storage import Storage

LINES = [LineSpan(f"seg-{i + 1:04d}", i * 2000, i * 2000 + 1500) for i in range(4)]


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("speaker runs must not use the network")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
    monkeypatch.setattr(socket, "getaddrinfo", refuse)


def fake_child(tmp_path: Path, body: str) -> list[str]:
    """A stand-in child: `spec` (the parsed spec) and `write(obj)` are available to `body`."""
    script = tmp_path / "fake_child.py"
    script.write_text(
        "import json, os, sys, time\n"
        "spec = json.loads(open(sys.argv[-1]).read())\n"
        "def write(obj):\n"
        "    open(spec['result'], 'w').write(json.dumps(obj))\n" + textwrap.dedent(body),
        encoding="utf-8",
    )
    return [sys.executable, str(script)]


GOOD = """
ids = [line["id"] for line in spec["lines"]]
write({"result": {
    "assignments": {i: ("S1" if n % 2 == 0 else "S2") for n, i in enumerate(ids)},
    "speakers": [{"id": "S1", "lines": 2, "windows": 6}, {"id": "S2", "lines": 2, "windows": 6}],
    "windows": 12, "noiseWindows": 0, "unassignedLines": 0, "clustering": "fake",
}})
"""


def wav(path: Path, seconds: float = 8.0) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as out:
        out.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        out.writeframes(b"\x00\x00" * int(16000 * seconds))
    return path


def storage_at(tmp_path: Path) -> Storage:
    storage = Storage(tmp_path / "pebble")
    storage.ensure()
    return storage


def leftovers(storage: Storage) -> list[str]:
    return sorted(p.name for p in storage.tmp_dir.iterdir())


# --- the child's environment --------------------------------------------------------------------


def test_the_child_environment_drops_keys_and_credentials(tmp_path, monkeypatch):
    for name, value in {
        "DEEPL_AUTH_KEY": "secret-key",
        "AWS_SECRET_ACCESS_KEY": "secret",
        "GITHUB_TOKEN": "secret",
        "HTTPS_PROXY": "http://proxy.invalid",
        "PYTHONPATH": "/somewhere",
        "LANG": "en_US.UTF-8",
    }.items():
        monkeypatch.setenv(name, value)
    storage = storage_at(tmp_path)
    scratch = tmp_path / "scratch"
    env = runner.child_environment(storage, scratch)
    assert "secret" not in json.dumps(env) and "proxy" not in json.dumps(env).lower()
    assert "PYTHONPATH" not in env and env["LANG"] == "en_US.UTF-8"
    for name in ("HOME", "TMPDIR", "NUMBA_CACHE_DIR", "MODELSCOPE_HOME", "MODELSCOPE_CACHE"):
        assert Path(env[name]).is_relative_to(scratch), name
    assert env["PYTHONDONTWRITEBYTECODE"] == "1" and env["HF_HUB_OFFLINE"] == "1"
    assert env["PEBBLE_DATA_DIR"] == str(storage.root)


def test_a_fake_child_sees_only_the_minimal_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("DEEPL_AUTH_KEY", "secret-key")
    storage = storage_at(tmp_path)
    report = tmp_path / "env.json"
    command = fake_child(
        tmp_path,
        f"open({str(report)!r}, 'w').write(json.dumps({{'env': dict(os.environ), "
        "'cwd': os.getcwd()}))\n" + GOOD,
    )
    outcome = runner.run_child(
        storage, audio=tmp_path / "a.wav", lines=LINES, timeout_seconds=30, command=command
    )
    assert outcome.code is None and outcome.result.assignments["seg-0002"] == "S2"
    seen = json.loads(report.read_text())
    assert "DEEPL_AUTH_KEY" not in seen["env"] and "secret-key" not in json.dumps(seen)
    assert Path(seen["cwd"]).parent == storage.tmp_dir.resolve()
    assert leftovers(storage) == []  # the scratch folder (spec, result, caches) is gone


# --- outcomes -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ('write({"error": "SPEAKER_MODEL_UNAVAILABLE"})', "SPEAKER_MODEL_UNAVAILABLE"),
        ('write({"error": "Traceback: /Users/someone/file.py"})', "RESULT_INVALID"),
        ('write({"result": {"assignments": {"seg-9": "S1"}}})', "RESULT_INVALID"),
        ("open(spec['result'], 'w').write('not json')", "RESULT_INVALID"),
        ("sys.stderr.write('secret-key /Users/x boom'); sys.exit(1)", "CHILD_FAILED"),
    ],
)
def test_child_results_are_reduced_to_fixed_codes(tmp_path, body, code):
    storage = storage_at(tmp_path)
    outcome = runner.run_child(
        storage,
        audio=tmp_path / "a.wav",
        lines=LINES,
        timeout_seconds=30,
        command=fake_child(tmp_path, body),
    )
    assert (outcome.code, outcome.result) == (code, None)
    assert leftovers(storage) == []


def test_inconsistent_counts_are_rejected(tmp_path):
    body = GOOD.replace('"unassignedLines": 0', '"unassignedLines": 3')
    outcome = runner.run_child(
        storage_at(tmp_path),
        audio=tmp_path / "a.wav",
        lines=LINES,
        timeout_seconds=30,
        command=fake_child(tmp_path, body),
    )
    assert outcome.code == "RESULT_INVALID"


def test_a_child_that_ignores_sigterm_is_killed_within_bounds(tmp_path):
    storage = storage_at(tmp_path)
    pid_file = tmp_path / "pid"
    body = f"""
import signal
signal.signal(signal.SIGTERM, signal.SIG_IGN)
open({str(pid_file)!r}, 'w').write(str(os.getpid()))
time.sleep(600)
"""
    started = time.monotonic()
    outcome = runner.run_child(
        storage,
        audio=tmp_path / "a.wav",
        lines=LINES,
        timeout_seconds=0.5,
        grace_seconds=0.5,
        command=fake_child(tmp_path, body),
    )
    assert outcome.code == "TIMED_OUT"
    assert time.monotonic() - started < 15
    pid = int(pid_file.read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
    assert leftovers(storage) == []


def test_cancellation_stops_the_child_promptly(tmp_path):
    storage = storage_at(tmp_path)
    calls = {"n": 0}

    def cancel():
        calls["n"] += 1
        return calls["n"] > 2

    started = time.monotonic()
    outcome = runner.run_child(
        storage,
        audio=tmp_path / "a.wav",
        lines=LINES,
        timeout_seconds=600,
        cancel=cancel,
        grace_seconds=1,
        command=fake_child(tmp_path, "time.sleep(600)"),
    )
    assert outcome.code == "CANCELLED" and time.monotonic() - started < 10
    assert leftovers(storage) == []


def test_deadline_scales_with_audio_and_is_capped():
    assert runner.deadline_seconds(0) == 600
    assert runner.deadline_seconds(3_600_000) == 1500
    assert runner.deadline_seconds(4 * 3_600_000) == runner.MAX_DEADLINE_SECONDS == 4200
    assert runner.deadline_seconds(10 * 3_600_000) == 4200


# --- the real child entry point (no model installed) ----------------------------------------------


def test_the_real_child_denies_the_network_then_reports_a_missing_model(tmp_path):
    storage = storage_at(tmp_path)
    audio = wav(tmp_path / "a.wav")
    outcome = runner.run_child(storage, audio=audio, lines=LINES, timeout_seconds=120)
    assert outcome.code == "SPEAKER_MODEL_UNAVAILABLE"
    assert leftovers(storage) == []
    assert not (storage.root / "models").exists()  # nothing downloaded or created


def test_the_real_child_refuses_to_run_if_network_denial_fails(tmp_path):
    spec = tmp_path / "spec.json"
    result = tmp_path / "result.json"
    spec.write_text(
        json.dumps(
            {
                "audio": str(wav(tmp_path / "a.wav")),
                "lines": [],
                "deadlineAt": time.time() + 60,
                "result": str(result),
                "numbaCache": str(tmp_path / "numba"),
            }
        )
    )
    code = textwrap.dedent(
        f"""
        import sys
        from pebble_worker.speakers import child, isolation
        isolation.deny_network = lambda: None  # simulate a guard that didn't install
        sys.exit(child.main([{str(spec)!r}]))
        """
    )
    completed_process = subprocess.run(
        [sys.executable, "-c", code],
        env={"PATH": "/usr/bin:/bin", "PEBBLE_DATA_DIR": str(tmp_path / "pebble")},
        capture_output=True,
        timeout=60,
        check=False,
    )
    assert completed_process.returncode == 3
    assert json.loads(result.read_text()) == {"error": "NETWORK_ISOLATION_FAILED"}


# --- the whole run, parent side -------------------------------------------------------------------


@pytest.fixture
def episode_db(tmp_path):
    storage = storage_at(tmp_path)
    database = Database(storage.db_path)
    database.migrate()
    with database.tx() as conn:
        seed(conn)
        seed(conn, OTHER)
    wav(storage.work_dir(EPISODE) / "normalized.wav")
    return storage, database


def test_execute_run_persists_a_validated_result(tmp_path, episode_db):
    storage, database = episode_db
    store = SpeakerStore(database)
    run = store.create_run(EPISODE)
    status = runner.execute_run(
        database, storage, Settings(data_dir=storage.root), run, command=fake_child(tmp_path, GOOD)
    )
    assert status == "completed"
    current = store.episode_speakers(EPISODE)["current"]
    assert current["runId"] == run and current["assignments"]["seg-0002"] == "S2"
    assert leftovers(storage) == []


def test_a_failed_redetection_keeps_the_previous_result(tmp_path, episode_db):
    storage, database = episode_db
    store = SpeakerStore(database)
    first = completed(store, "S1", "S2", "S1", "S2")
    run = store.create_run(EPISODE)
    status = runner.execute_run(
        database,
        storage,
        Settings(data_dir=storage.root),
        run,
        command=fake_child(tmp_path, 'write({"error": "CLUSTERING_FAILED"})'),
    )
    payload = store.episode_speakers(EPISODE)
    assert status == "failed" and payload["current"]["runId"] == first
    assert payload["latest"]["failure"]["code"] == "CLUSTERING_FAILED"


def test_episode_deleted_during_a_run_is_discarded_cleanly(tmp_path, episode_db):
    storage, database = episode_db
    run = SpeakerStore(database).create_run(EPISODE)

    def delete_once():
        with database.tx() as conn:
            conn.execute("DELETE FROM episodes WHERE id = ?", (EPISODE,))
        return False

    status = runner.execute_run(
        database,
        storage,
        Settings(data_dir=storage.root),
        run,
        cancel=delete_once,
        command=fake_child(tmp_path, "time.sleep(0.5)\n" + GOOD),
    )
    assert status == "gone"
    with database.tx() as conn:
        assert conn.execute("SELECT COUNT(*) FROM speaker_runs").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM speaker_assignments").fetchone()[0] == 0
    assert leftovers(storage) == []


def test_missing_normalized_audio_uses_a_temporary_copy_that_is_removed(tmp_path, episode_db):
    storage, database = episode_db
    (storage.work_dir(EPISODE) / "normalized.wav").unlink()
    made: list[Path] = []

    def normalizer(source, target):
        made.append(target)
        wav(target)
        return 8000

    run = SpeakerStore(database).create_run(EPISODE)
    status = runner.execute_run(
        database,
        storage,
        Settings(data_dir=storage.root),
        run,
        command=fake_child(tmp_path, GOOD),
        normalizer=normalizer,
    )
    assert status == "completed" and made and not made[0].exists()
    assert leftovers(storage) == []


def test_transcription_tables_are_untouched_by_speaker_runs(tmp_path, episode_db):
    storage, database = episode_db
    with database.tx() as conn:
        before = [tuple(r) for r in conn.execute("SELECT * FROM transcripts ORDER BY episode_id")]
    run = SpeakerStore(database).create_run(EPISODE)
    runner.execute_run(
        database, storage, Settings(data_dir=storage.root), run, command=fake_child(tmp_path, GOOD)
    )
    with database.tx() as conn:
        after = [tuple(r) for r in conn.execute("SELECT * FROM transcripts ORDER BY episode_id")]
        translations = conn.execute("SELECT COUNT(*) FROM translations").fetchone()[0]
    assert after == before and translations == 0


# --- lifecycle ----------------------------------------------------------------------------------


def test_bounded_termination_also_stops_descendants(tmp_path):
    storage = storage_at(tmp_path)
    pids = tmp_path / "pids"
    body = f"""
import signal, subprocess
signal.signal(signal.SIGTERM, signal.SIG_IGN)
grandchild = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
open({str(pids)!r}, 'w').write(json.dumps([os.getpid(), grandchild.pid]))
time.sleep(600)
"""
    outcome = runner.run_child(
        storage,
        audio=tmp_path / "a.wav",
        lines=LINES,
        timeout_seconds=1,
        grace_seconds=0.5,
        command=fake_child(tmp_path, body),
    )
    assert outcome.code == "TIMED_OUT"
    for pid in json.loads(pids.read_text()):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        else:
            pytest.fail(f"process {pid} survived")
    assert leftovers(storage) == []


def test_cancelling_the_episodes_runs_stops_a_live_child(tmp_path, episode_db):
    import threading

    storage, database = episode_db
    store = SpeakerStore(database)
    run = store.create_run(EPISODE)
    timer = threading.Timer(0.5, lambda: store.cancel_for_episode(EPISODE))
    timer.start()
    started = time.monotonic()
    status = runner.execute_run(
        database,
        storage,
        Settings(data_dir=storage.root),
        run,
        grace_seconds=1,
        command=fake_child(tmp_path, "time.sleep(600)\n" + GOOD),
    )
    timer.join()
    assert status == "cancelled" and time.monotonic() - started < 15
    assert store.episode_speakers(EPISODE)["latest"]["failure"]["code"] == "CANCELLED"
    assert leftovers(storage) == []


def test_a_result_for_a_replaced_transcript_is_never_published(tmp_path, episode_db):
    storage, database = episode_db
    store = SpeakerStore(database)
    run = store.create_run(EPISODE)
    replaced = {"done": False}

    def replace_transcript_once():
        if not replaced["done"]:
            with database.tx() as conn:
                conn.execute(
                    "UPDATE transcripts SET created_at = '2026-10-09T00:00:00.000Z' "
                    "WHERE episode_id = ?",
                    (EPISODE,),
                )
            replaced["done"] = True
        return False

    status = runner.execute_run(
        database,
        storage,
        Settings(data_dir=storage.root),
        run,
        cancel=replace_transcript_once,
        command=fake_child(tmp_path, "time.sleep(0.5)\n" + GOOD),
    )
    payload = store.episode_speakers(EPISODE)
    assert status == "failed" and payload["current"] is None
    assert payload["latest"]["failure"]["code"] == "TRANSCRIPT_CHANGED"
    with database.tx() as conn:
        assert conn.execute("SELECT COUNT(*) FROM speaker_assignments").fetchone()[0] == 0


def test_restart_policy_resumes_queued_and_fails_running(tmp_path, episode_db):
    storage, database = episode_db
    store = SpeakerStore(database)
    running = store.create_run(EPISODE)
    store.start(running)
    queued = store.create_run(OTHER)
    wav(storage.work_dir(OTHER) / "normalized.wav")
    assert store.recover_interrupted() == [running]
    assert store.queued_runs() == [queued]  # resumed, oldest first; never the interrupted one
    assert store.episode_speakers(EPISODE)["latest"]["failure"]["code"] == "WORKER_RESTARTED"
    assert (
        runner.execute_run(
            database, storage, Settings(data_dir=storage.root), running, command=["/bin/false"]
        )
        == "gone"
    )  # an interrupted run can't be started again
    assert (
        runner.execute_run(
            database,
            storage,
            Settings(data_dir=storage.root),
            queued,
            command=fake_child(tmp_path, GOOD),
        )
        == "completed"
    )


def test_only_validated_speaker_scratch_is_removed(tmp_path):
    storage = storage_at(tmp_path)
    (storage.tmp_dir / "speakers-a1B2_c3d" / "numba").mkdir(parents=True)  # ours: removed
    (storage.tmp_dir / "speakers-abc").mkdir()  # wrong shape: kept
    (storage.tmp_dir / "speakers-filefile").write_text("a file, not a folder")
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "keep.txt").write_text("not ours")
    (storage.tmp_dir / "speakers-linklink").symlink_to(outside, target_is_directory=True)
    (storage.tmp_dir / "upload-spool").write_text("not ours")
    assert runner.remove_stale_scratch(storage) == 1
    assert leftovers(storage) == [
        "speakers-abc",
        "speakers-filefile",
        "speakers-linklink",
        "upload-spool",
    ]
    assert (outside / "keep.txt").exists()  # a symlink is never followed
