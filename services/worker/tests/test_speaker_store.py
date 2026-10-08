"""
Migration 3 and the speaker store (ADR 0009) on temporary databases with invented episodes,
segments and results only.
"""

from __future__ import annotations

import json
import sqlite3

import pytest

from pebble_worker.contract import parse_speaker_corrections_request
from pebble_worker.db import MIGRATIONS, Database
from pebble_worker.speakers.core import DiarizationResult, Speaker
from pebble_worker.speakers.store import (
    FAILURES,
    CorrectionError,
    SpeakerConflict,
    SpeakerNotAvailable,
    SpeakerStore,
    apply_corrections,
)

EPISODE = "ep-0123456789ab"
OTHER = "ep-ba9876543210"
TEXT = "这是一句虚构的测试文本"  # invented; must never reach a speaker table
STAMP = "2026-10-07T00:00:00.000Z"
OLD_TABLES = (
    "episodes",
    "jobs",
    "chunks",
    "transcripts",
    "translations",
    "translation_usage",
    "translation_attempts",
    "translation_consent",
)
SPEAKER_TABLES = ("speaker_runs", "speaker_labels", "speaker_assignments", "speaker_corrections")


def transcript(episode: str, n: int = 4, *, created: str = STAMP) -> str:
    return json.dumps(
        {
            "schemaVersion": "1.8",
            "episodeId": episode,
            "segments": [
                {
                    "id": f"seg-{i + 1:04d}",
                    "startMs": i * 2000,
                    "endMs": i * 2000 + 1500,
                    "text": TEXT,
                }
                for i in range(n)
            ],
            "created": created,
        },
        ensure_ascii=False,
    )


def seed(conn: sqlite3.Connection, episode: str = EPISODE) -> None:
    conn.execute(
        "INSERT INTO episodes VALUES (?, 'Invented', 'x.m4a', ?, 'audio/mp4', 8000, 'zh-CN', ?, ?)",
        (episode, f"episodes/{episode}/source.m4a", STAMP, STAMP),
    )
    conn.execute(
        """INSERT INTO jobs (id, episode_id, status, attempt, provider_id, provider_kind,
                             created_at, updated_at)
           VALUES (?, ?, 'completed', 1, 'funasr', 'asr', ?, ?)""",
        (f"job-{episode[3:]}", episode, STAMP, STAMP),
    )
    conn.execute(
        "INSERT INTO transcripts VALUES (?, ?, 1, ?, ?)",
        (episode, f"job-{episode[3:]}", transcript(episode), STAMP),
    )


@pytest.fixture
def db(tmp_path) -> Database:
    database = Database(tmp_path / "pebble.db")
    database.migrate()
    with database.tx() as conn:
        seed(conn)
        seed(conn, OTHER)
    return database


def result(*speakers_per_line: str | None, clustering: str = "fake") -> DiarizationResult:
    assignments = {f"seg-{i + 1:04d}": s for i, s in enumerate(speakers_per_line)}
    ids = sorted({s for s in speakers_per_line if s}, key=lambda s: int(s[1:]))
    return DiarizationResult(
        assignments=assignments,
        speakers=tuple(Speaker(i, sum(s == i for s in speakers_per_line), 3) for i in ids),
        windows=3 * len(speakers_per_line),
        noise_windows=0,
        unassigned_lines=sum(s is None for s in speakers_per_line),
        clustering=clustering,
    )


def completed(store: SpeakerStore, *speakers: str | None, episode: str = EPISODE) -> str:
    run = store.create_run(episode)
    assert store.start(run)
    assert store.complete(run, result(*speakers)) == "completed"
    return run


def schema(conn: sqlite3.Connection) -> list[tuple]:
    rows = conn.execute("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL")
    return sorted(tuple(r) for r in rows)


def dump(conn: sqlite3.Connection, tables) -> dict[str, list[tuple]]:
    return {
        t: [tuple(r) for r in conn.execute(f"SELECT * FROM {t} ORDER BY rowid")] for t in tables
    }


# --- migration ------------------------------------------------------------------------------------


def test_migration_3_from_v2_keeps_every_existing_row_and_is_repeatable(tmp_path):
    path = tmp_path / "pebble.db"
    conn = sqlite3.connect(path)
    for number, sql in enumerate(MIGRATIONS[:2], start=1):
        conn.executescript(f"BEGIN; {sql}; PRAGMA user_version = {number}; COMMIT;")
    seed(conn)
    conn.execute(
        "INSERT INTO translations VALUES "
        "(?, 'seg-0001', ?, 'deepl', 'EN-US', 1, 11, 'Invented.', ?)",
        (EPISODE, "a" * 64, STAMP),
    )
    conn.execute("INSERT INTO translation_usage VALUES ('2026-10', 3, 30)")
    conn.execute("INSERT INTO translation_consent VALUES ('deepl', 'v1', ?)", (STAMP,))
    conn.commit()
    before = dump(conn, OLD_TABLES)
    schema_before = schema(conn)
    conn.close()

    database = Database(path)
    assert database.migrate() == 3 and database.schema_version == 3
    with database.tx() as conn:
        assert dump(conn, OLD_TABLES) == before
        schema_after = schema(conn)
        assert [r for r in schema_after if r[0] in {n for n, _ in schema_before}] == schema_before
        assert all(dump(conn, SPEAKER_TABLES)[t] == [] for t in SPEAKER_TABLES)

    database.migrate()  # again: nothing changes
    assert database.schema_version == 3
    with database.tx() as conn:
        assert dump(conn, OLD_TABLES) == before
        again = schema(conn)
        assert again == schema_after


def test_constraints_reject_bad_rows(db):
    with pytest.raises(sqlite3.IntegrityError), db.tx() as conn:  # failure code without a failure
        conn.execute(
            """INSERT INTO speaker_runs (id, episode_id, status, failure_code, model_id,
                 model_revision, transcript_created_at, created_at, updated_at)
               VALUES ('spk-000000000001', ?, 'running', 'TIMED_OUT', 'm', 'r', ?, ?, ?)""",
            (EPISODE, STAMP, STAMP, STAMP),
        )
    with pytest.raises(sqlite3.IntegrityError), db.tx() as conn:  # free text as a failure code
        conn.execute(
            """INSERT INTO speaker_runs (id, episode_id, status, failure_code, model_id,
                 model_revision, transcript_created_at, created_at, updated_at)
               VALUES ('spk-000000000002', ?, 'failed', 'Error: /Users/x', 'm', 'r', ?, ?, ?)""",
            (EPISODE, STAMP, STAMP, STAMP),
        )
    with pytest.raises(sqlite3.IntegrityError), db.tx() as conn:  # a run for no episode
        conn.execute(
            """INSERT INTO speaker_runs (id, episode_id, status, model_id, model_revision,
                 transcript_created_at, created_at, updated_at)
               VALUES ('spk-000000000003', 'ep-ffffffffffff', 'queued', 'm', 'r', ?, ?, ?)""",
            (STAMP, STAMP, STAMP),
        )


# --- runs ---------------------------------------------------------------------------------------


def test_a_completed_run_is_current_with_ordered_generic_ids(db):
    store = SpeakerStore(db)
    run = completed(store, "S1", "S2", None, "S1")
    payload = store.episode_speakers(EPISODE)
    current = payload["current"]
    assert current["runId"] == run and payload["latest"]["status"] == "completed"
    assert [s["id"] for s in current["speakers"]] == ["S1", "S2"]
    assert current["assignments"] == {
        "seg-0001": "S1",
        "seg-0002": "S2",
        "seg-0003": None,
        "seg-0004": "S1",
    }
    assert current["effective"] == current["assignments"] and current["corrections"] is None
    assert current["provenance"]["modelRevision"] == "v2.0.2"
    assert store.episode_speakers(OTHER) == {
        "schemaVersion": payload["schemaVersion"],
        "episodeId": OTHER,
        "current": None,
        "latest": None,
    }


def test_one_active_run_per_episode_and_a_transcript_is_required(db):
    store = SpeakerStore(db)
    store.create_run(EPISODE)
    with pytest.raises(SpeakerConflict):
        store.create_run(EPISODE)
    store.create_run(OTHER)  # other episodes are independent
    with db.tx() as conn:
        conn.execute("DELETE FROM transcripts WHERE episode_id = ?", (OTHER,))
    with pytest.raises(SpeakerNotAvailable):
        SpeakerStore(db).create_run(OTHER)


@pytest.mark.parametrize(("code", "status"), [("TIMED_OUT", "failed"), ("CANCELLED", "cancelled")])
def test_failed_or_cancelled_redetection_keeps_the_last_successful_run(db, code, status):
    store = SpeakerStore(db)
    first = completed(store, "S1", "S2", "S2", "S1")
    second = store.create_run(EPISODE)
    pending = store.episode_speakers(EPISODE)
    assert pending["current"]["runId"] == first and pending["latest"]["status"] == "queued"
    store.start(second)
    assert store.fail(second, code)
    payload = store.episode_speakers(EPISODE)
    assert payload["current"]["runId"] == first
    assert payload["latest"]["runId"] == second and payload["latest"]["status"] == status
    message, retryable = FAILURES[code]
    assert payload["latest"]["failure"] == {
        "code": code,
        "message": message,
        "retryable": retryable,
    }
    assert not store.fail(second, "CHILD_FAILED")  # already finished
    with pytest.raises(ValueError):
        store.fail(first, "Something with /Users/a/path")  # type: ignore[arg-type]


def test_a_newer_transcript_makes_runs_stale_instead_of_repointing_them(db):
    store = SpeakerStore(db)
    run = completed(store, "S1", "S1", "S2", "S2")
    queued = store.create_run(EPISODE)
    with db.tx() as conn:
        conn.execute(
            "UPDATE transcripts SET created_at = '2026-10-08T00:00:00.000Z' WHERE episode_id = ?",
            (EPISODE,),
        )
    payload = store.episode_speakers(EPISODE)
    assert payload["current"] is None and payload["latest"]["runId"] == queued
    store.start(queued)
    assert store.lines_for(queued) is None
    assert run != queued


def test_deleting_the_episode_during_a_run_leaves_nothing_behind(db):
    store = SpeakerStore(db)
    completed(store, "S1", "S2", "S1", "S2")
    run = store.create_run(EPISODE)
    store.start(run)
    with db.tx() as conn:
        conn.execute("DELETE FROM episodes WHERE id = ?", (EPISODE,))
    assert store.complete(run, result("S1", "S1", "S1", "S1")) == "discarded"
    assert store.fail(run, "CHILD_FAILED") is False
    with db.tx() as conn:
        rows = dump(conn, SPEAKER_TABLES)
    assert all(row[0] != run for t in SPEAKER_TABLES for row in rows[t])
    assert all(EPISODE not in json.dumps(rows[t]) for t in SPEAKER_TABLES)
    with pytest.raises(SpeakerNotAvailable):
        store.episode_speakers(EPISODE)


def test_restart_recovery_fails_running_runs_only(db):
    store = SpeakerStore(db)
    running = store.create_run(EPISODE)
    store.start(running)
    queued = store.create_run(OTHER)
    assert store.recover_interrupted() == [running]
    assert store.episode_speakers(EPISODE)["latest"]["failure"]["code"] == "WORKER_RESTARTED"
    assert store.episode_speakers(OTHER)["latest"]["status"] == "queued" and queued


# --- corrections --------------------------------------------------------------------------------


def request(run: str, episode: str = EPISODE, revision: int | None = None, **fields):
    body = {
        "schemaVersion": "1.9",
        "episodeId": episode,
        "runId": run,
        "revision": 0 if revision is None else revision,
        "names": {},
        "merges": {},
        "notSpeaker": [],
        "lines": {},
        **fields,
    }
    parsed = parse_speaker_corrections_request(body)
    assert parsed.ok, parsed.issues
    return parsed.data


def test_corrections_apply_over_originals_which_stay_unchanged(db):
    store = SpeakerStore(db)
    run = completed(store, "S1", "S2", "S3", "S4")
    payload = store.put_corrections(
        request(
            run,
            names={"S1": "Host", "S2": "Guest"},
            merges={"S3": "S1"},
            notSpeaker=["S4"],
            lines={"seg-0001": "S2"},
        )
    )
    current = payload["current"]
    assert current["assignments"] == {
        "seg-0001": "S1",
        "seg-0002": "S2",
        "seg-0003": "S3",
        "seg-0004": "S4",
    }
    assert current["effective"] == {
        "seg-0001": "S2",
        "seg-0002": "S2",
        "seg-0003": "S1",
        "seg-0004": None,
    }
    assert current["corrections"]["names"] == {"S1": "Host", "S2": "Guest"}
    assert current["corrections"]["revision"] == 1
    # A stale edit (still based on revision 0) is refused and changes nothing.
    with pytest.raises(CorrectionError) as raised:
        store.put_corrections(request(run, revision=0, names={"S1": "Other"}))
    assert raised.value.code == "REVISION_CONFLICT"
    assert store.episode_speakers(EPISODE)["current"]["corrections"]["names"]["S1"] == "Host"
    # Replacing them (based on revision 1) is a full replacement, not a merge.
    payload = store.put_corrections(request(run, revision=1, names={"S2": "Guest 2"}))
    assert payload["current"]["corrections"]["names"] == {"S2": "Guest 2"}
    assert payload["current"]["corrections"]["revision"] == 2
    assert payload["current"]["effective"] == payload["current"]["assignments"]


@pytest.mark.parametrize(
    ("fields", "path"),
    [
        ({"names": {"S9": "Nobody"}}, "names"),
        ({"merges": {"S2": "S9"}}, "merges"),
        ({"notSpeaker": ["S7"]}, "notSpeaker"),
        ({"lines": {"seg-9999": "S1"}}, "lines.seg-9999"),
        ({"lines": {"seg-0001": "S5"}}, "lines"),
    ],
)
def test_corrections_must_refer_to_the_runs_own_speakers_and_lines(db, fields, path):
    store = SpeakerStore(db)
    run = completed(store, "S1", "S2", "S1", "S2")
    with pytest.raises(CorrectionError) as raised:
        store.put_corrections(request(run, **fields))
    assert raised.value.code == "INVALID_CORRECTIONS"
    assert any(p == path for p, _ in raised.value.issues)


def test_old_corrections_never_apply_to_a_new_run(db):
    store = SpeakerStore(db)
    first = completed(store, "S1", "S2", "S1", "S2")
    store.put_corrections(request(first, names={"S1": "Host"}))
    second = completed(store, "S2", "S1", "S2", "S1")
    assert store.episode_speakers(EPISODE)["current"]["corrections"] is None
    with pytest.raises(CorrectionError) as raised:
        store.put_corrections(request(first, names={"S1": "Host"}))
    assert raised.value.code == "RUN_MISMATCH"
    with pytest.raises(CorrectionError) as raised:
        store.put_corrections(request(second, episode=OTHER))
    assert raised.value.code == "RUN_MISMATCH"
    failed = store.create_run(EPISODE)
    store.start(failed)
    store.fail(failed, "CHILD_FAILED")
    with pytest.raises(CorrectionError) as raised:
        store.put_corrections(request(failed))
    assert raised.value.code == "RUN_NOT_COMPLETED"


def test_episode_deletion_cascades_runs_and_corrections_only_for_that_episode(db):
    store = SpeakerStore(db)
    run = completed(store, "S1", "S2", "S1", "S2")
    store.put_corrections(request(run, names={"S1": "Host"}))
    kept = completed(store, "S1", "S1", "S1", "S1", episode=OTHER)
    with db.tx() as conn:
        conn.execute("DELETE FROM episodes WHERE id = ?", (EPISODE,))
        rows = dump(conn, SPEAKER_TABLES)
    assert [r[0] for r in rows["speaker_runs"]] == [kept]
    assert {r[0] for t in SPEAKER_TABLES[1:] for r in rows[t]} <= {kept}


def test_nothing_persisted_holds_text_paths_or_exception_detail(db, tmp_path):
    store = SpeakerStore(db)
    run = completed(store, "S1", "S2", "S1", "S2")
    store.put_corrections(request(run, names={"S1": "Host"}))
    failed = store.create_run(EPISODE)
    store.start(failed)
    store.fail(failed, "EMBEDDING_FAILED")
    with db.tx() as conn:
        persisted = json.dumps(dump(conn, SPEAKER_TABLES), ensure_ascii=False)
    payload = json.dumps(store.episode_speakers(EPISODE), ensure_ascii=False)
    for blob in (persisted, payload):
        assert TEXT not in blob and str(tmp_path) not in blob and "Traceback" not in blob


def test_apply_corrections_order_of_precedence():
    original = {"a": "S1", "b": "S2", "c": "S3", "d": None}
    corrections = {"merges": {"S3": "S1"}, "notSpeaker": ["S2"], "lines": {"b": "S1", "d": "S3"}}
    assert apply_corrections(original, corrections) == {"a": "S1", "b": "S1", "c": "S1", "d": "S3"}
    assert apply_corrections(original, None) == original
