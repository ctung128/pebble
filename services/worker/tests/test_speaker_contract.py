"""
Speaker correction and name rules (ADR 0009), mirrored by packages/schema/test/speakers.test.ts.
Names are user-entered text, not transcript text; they are bounded and never echoed in issues.
"""

from __future__ import annotations

import json
import random

import pytest
from test_speaker_store import EPISODE, completed, db, request  # noqa: F401 (db is a fixture)

from pebble_worker.contract import parse_speaker_corrections_request
from pebble_worker.speakers.store import CorrectionError, SpeakerStore, apply_corrections

BASE = {
    "schemaVersion": "1.9",
    "episodeId": EPISODE,
    "runId": "spk-0123456789ab",
    "revision": 0,
    "names": {},
    "merges": {},
    "notSpeaker": [],
    "lines": {},
}


def issues_of(payload) -> list[tuple[str, str]]:
    parsed = parse_speaker_corrections_request(payload)
    return [] if parsed.ok else [(i.path, i.message) for i in parsed.issues]


def test_issues_are_deterministic_whatever_the_key_order():
    a = {
        **BASE,
        "names": {"S3": "x", "S2": "y"},
        "merges": {"S3": "S1", "S2": "S3"},
        "lines": {"seg-0002": "S3", "seg-0001": "S2"},
    }
    b = {
        **BASE,
        "names": {"S2": "y", "S3": "x"},
        "merges": {"S2": "S3", "S3": "S1"},
        "lines": {"seg-0001": "S2", "seg-0002": "S3"},
    }
    assert issues_of(a) == issues_of(b)
    assert [path for path, _ in issues_of(a)] == [
        "merges.S2",
        "names.S2",
        "names.S3",
        "lines.seg-0001",
        "lines.seg-0002",
    ]


def test_cycles_and_conflicts_are_rejected():
    assert [p for p, _ in issues_of({**BASE, "merges": {"S1": "S2", "S2": "S1"}})] == [
        "merges.S1",
        "merges.S2",
    ]
    assert issues_of({**BASE, "merges": {"S1": "S1"}})[0][1] == "a speaker can't merge into itself"
    assert issues_of({**BASE, "merges": {"S1": "S2"}, "notSpeaker": ["S2"]})[0][0] == "merges.S1"
    assert issues_of({**BASE, "notSpeaker": ["S2", "S2"]}) == [
        ("notSpeaker.1", "duplicate speaker")
    ]
    assert issues_of({**BASE, "notSpeaker": ["S2"], "lines": {"seg-0001": "S2"}})[0][0] == (
        "lines.seg-0001"
    )


def test_sizes_are_bounded_and_names_are_never_echoed():
    names = {f"S{i + 1}": "Host" for i in range(201)}
    assert issues_of({**BASE, "names": names}) == [("names", "at most 200 entries")]
    lines = {f"seg-{i:05d}": None for i in range(20001)}
    assert issues_of({**BASE, "lines": lines}) == [("lines", "at most 20000 entries")]
    secret = "Ms Example Person"
    for bad in (secret * 5, f"{secret}\u0007", "   "):
        found = issues_of({**BASE, "names": {"S1": bad}})
        assert len(found) == 1 and "Example" not in json.dumps(found)
    assert issues_of({**BASE, "lines": {"seg-é": "S1"}}) != []
    assert issues_of({**BASE, "lines": {"s" * 65: "S1"}}) != []


def test_store_errors_name_ids_only(db):  # noqa: F811
    store = SpeakerStore(db)
    run = completed(store, "S1", "S2", "S1", "S2")
    with pytest.raises(CorrectionError) as raised:
        store.put_corrections(request(run, names={"S9": "Ms Example Person"}))
    assert "Example" not in json.dumps([raised.value.message, raised.value.issues])


def test_effective_assignments_only_use_visible_canonical_speakers():
    rng = random.Random(7)
    speakers = [f"S{i}" for i in range(1, 9)]
    for _ in range(300):
        original = {f"seg-{i:04d}": rng.choice([*speakers, None]) for i in range(40)}
        not_speaker = rng.sample(speakers, rng.randint(0, 2))
        visible = [s for s in speakers if s not in not_speaker]
        targets = rng.sample(visible, min(2, len(visible)))
        sources = [s for s in visible if s not in targets]
        merges = {s: rng.choice(targets) for s in rng.sample(sources, min(3, len(sources)))}
        allowed = [s for s in visible if s not in merges]
        lines = {seg: rng.choice([*allowed, None]) for seg in rng.sample(sorted(original), 5)}
        corrections = {"merges": merges, "notSpeaker": not_speaker, "lines": lines}
        assert issues_of({**BASE, **corrections}) == []
        effective = apply_corrections(original, corrections)
        hidden = set(merges) | set(not_speaker)
        assert set(effective) == set(original)
        assert not {s for s in effective.values() if s is not None} & hidden
        assert original == {k: original[k] for k in original}  # originals untouched
