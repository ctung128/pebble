"""
The diarization evaluation harness (ADR 0009) on invented data only: synthetic audio, invented
lines, a fake embedder and clusterer. No model weights are loaded and nothing is downloaded.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import sys
import time
import wave
from pathlib import Path

import pytest

from pebble_worker.bench import diarize as bench
from pebble_worker.bench.diarize import Line, LineLabel
from pebble_worker.config import Settings
from pebble_worker.db import Database
from pebble_worker.storage import Storage

EPISODE = "ep-0123456789ab"
LINE_MS = 2500  # invented lines: 2.5 s each, back to back, alternating two speakers


# --- pure rules ---------------------------------------------------------------------------------


def test_window_count_matches_the_installed_sv_chunk():
    numpy = pytest.importorskip("numpy")
    utils = pytest.importorskip("funasr.models.campplus.utils")
    for ms in (200, 1499, 1500, 1501, 2250, 2251, 3000, 9999, 60000):
        region = numpy.zeros(ms * 16, dtype=numpy.float32)
        assert len(utils.sv_chunk([[0.0, ms / 1000, region]])) == bench.window_count(ms), ms


def test_clustering_path_follows_the_installed_thresholds():
    assert bench.clustering_path(19, None) == "single"
    assert bench.clustering_path(20, None) == "spectral"
    assert bench.clustering_path(2047, 3) == "spectral"
    assert bench.clustering_path(2048, None) == "umap-hdbscan"
    assert bench.clustering_path(4800, 2) == "kmeans"


def test_line_labels_use_episode_wide_ids_and_flag_estimated_turns():
    # Line 0 and 2 are the same voice even though they'd sit in different ASR chunks: one
    # clustering over the episode gives one id.
    window_lines = [0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 3, 3, 4]
    labels = [5, 5, 5, 2, 2, 5, 5, 5, 5, 2, 2, 2, 5, -1]
    result = bench.line_labels(window_lines, labels, 6)
    assert [r.speaker for r in result] == ["S1", "S2", "S1", "S2", None, None]
    # Line 1: 2 vs 2 → tie goes to the label heard first; 2 windows and 50% → mixed.
    assert result[1] == LineLabel("S2", True, 4)
    # Line 3: one window of 4 (25%) is below MIXED_MIN_WINDOWS → not mixed.
    assert result[3].mixed is False
    assert result[4] == LineLabel(None, False, 1)  # noise only
    assert result[5] == LineLabel(None, False, 0)  # no windows at all


def test_cluster_summary_keeps_noise_out_of_the_speaker_count():
    summary = bench.cluster_summary([0] * 98 + [1] * 1 + [-1] * 3)
    assert summary["speakers"] == 2
    assert summary["noiseWindows"] == 3
    assert summary["minorClusters"] == 1
    assert summary["windowShares"] == [0.9899, 0.0101]


def test_best_mapping_is_one_to_one_and_optimal():
    pairs = [("S1", "A")] * 5 + [("S2", "A")] * 4 + [("S2", "B")] * 3 + [("S3", "B")] * 1
    assert bench.best_mapping(pairs) == {"S1": "A", "S2": "B"}
    # More reference speakers than predicted: still one-to-one.
    assert bench.best_mapping([("S1", "A"), ("S1", "B"), ("S1", "B")]) == {"S1": "B"}
    assert bench.agreement(["S1", "S2", None], ["S9", "S8", "S7"]) == 1.0


def test_wilson_interval():
    assert bench.wilson(0, 0) is None
    low, high = bench.wilson(45, 50)
    assert 0.78 < low < 0.80 and 0.95 < high < 0.97


def _lines(n: int) -> list[Line]:
    return [
        Line(f"seg-{i + 1:04d}", i * LINE_MS, i * LINE_MS + (900 if i % 7 == 0 else 2400), "测试")
        for i in range(n)
    ]


def test_strata_partition_the_episode_first_match_wins():
    lines = _lines(10)  # lines 0 and 7 are short
    auto = [
        LineLabel(x, False, 3) for x in ["S1", "S1", "S2", "S2", "S2", "S1", "S1", "S2", "S2", "S2"]
    ]
    strata = bench.line_strata(lines, auto, difficult={2, 4, 7})
    assert strata == [
        "short",  # 0: short beats everything
        "spread",
        "transition",  # 2: a change beats difficult
        "spread",
        "difficult",
        "transition",
        "spread",
        "short",  # 7: short beats transition and difficult
        "spread",
        "spread",
    ]


def test_selection_is_bounded_seeded_stratified_and_keeps_each_lines_own_stratum():
    lines = _lines(400)
    auto = [LineLabel("S1" if (i // 3) % 2 else "S2", False, 3) for i in range(400)]
    strata = bench.line_strata(lines, auto, difficult={5, 50, 151, 398})
    picks = bench.select_lines(strata, count=50, seed=7)
    assert len(picks) == 50 and len({p.index for p in picks}) == 50
    assert picks == bench.select_lines(strata, count=50, seed=7)
    assert picks != bench.select_lines(strata, count=50, seed=8)
    assert all(p.stratum == strata[p.index] for p in picks)
    counts = {name: sum(p.stratum == name for p in picks) for name in bench.STRATUM_ORDER}
    # Quotas 10/12/10/18; only 4 difficult lines exist, so they are all taken and the shortfall
    # of 6 is filled at random from unpicked lines (labelled by their own strata).
    assert counts["difficult"] == 4
    assert counts["short"] >= 10 and counts["transition"] >= 12 and counts["spread"] >= 18
    spread = [i for i, s in enumerate(strata) if s == "spread"]
    quarters = {spread.index(p.index) * 4 // len(spread) for p in picks if p.stratum == "spread"}
    assert quarters == {0, 1, 2, 3}


def test_stratified_estimate_weights_strata_by_their_share_of_the_episode():
    from collections import Counter

    rows = [(i < 5, "short", 1000) for i in range(10)] + [(True, "spread", 3000)] * 10
    estimate = bench.stratified_estimate(rows, Counter(short=100, spread=900))
    # Raw sample accuracy would be 15/20 = 0.75; the episode is 90% spread lines.
    assert estimate["estimate"] == 0.95
    assert estimate["populationCovered"] == 1.0
    low, high = estimate["normal95"]
    assert low < 0.95 < high
    # An unreviewed stratum is left out and reported through populationCovered.
    partial = bench.stratified_estimate(rows, Counter(short=100, spread=900, difficult=1000))
    assert partial["estimate"] == 0.95 and partial["populationCovered"] == 0.5


def test_review_sheet_is_blind_and_reads_back_ticks_only(tmp_path):
    lines = _lines(3)
    picks = [bench.Pick(0, "short"), bench.Pick(2, "difficult")]
    path = tmp_path / "review.md"
    bench.write_review(path, run_id="run", audio=tmp_path / "a.wav", lines=lines, picks=picks)
    sheet = path.read_text(encoding="utf-8")
    assert "S1" not in sheet and "difficult" not in sheet and "mixed" not in sheet
    assert sheet.count("### L") == 2
    filled = (
        sheet.replace("(number): ", "(number): 2", 1)
        .replace("[ ] A", "[x] A", 1)
        .replace("[ ] one speaker", "[x] one speaker", 1)
    )
    second = filled.index("### L02")
    filled = filled[:second] + filled[second:].replace("[ ] B", "[x] B").replace("[ ] C", "[x] C")
    path.write_text(filled, encoding="utf-8")
    review = bench.read_review(path)
    assert review["total"] == 2
    assert review["items"]["L01"] == {"speaker": "A", "turns": "one speaker"}
    assert review["items"]["L02"] == {"speaker": None, "turns": None}  # two ticks: invalid
    assert review["invalid"] == 1
    assert "测试" not in json.dumps(review)


def test_score_reports_count_errors_line_accuracy_and_mixed_flags_separately():
    key = {
        "configs": ["auto"],
        "lines": [
            {
                "segmentId": "a",
                "stratum": "spread",
                "startMs": 0,
                "endMs": 3000,
                "auto": {"speaker": "S1", "mixed": False},
            },
            {
                "segmentId": "b",
                "stratum": "transition",
                "startMs": 3000,
                "endMs": 6000,
                "auto": {"speaker": "S2", "mixed": True},
            },
            {
                "segmentId": "c",
                "stratum": "short",
                "startMs": 6000,
                "endMs": 7000,
                "auto": {"speaker": "S1", "mixed": False},
            },
            {
                "segmentId": "d",
                "stratum": "difficult",
                "startMs": 7000,
                "endMs": 9500,
                "auto": {"speaker": "S2", "mixed": False},
            },
        ],
        "picks": [
            {"item": "L01", "segmentId": "a", "stratum": "spread"},
            {"item": "L02", "segmentId": "b", "stratum": "transition"},
            {"item": "L03", "segmentId": "c", "stratum": "short"},
            {"item": "L04", "segmentId": "d", "stratum": "difficult"},
        ],
    }
    review = {
        "total": 3,
        "invalid": 0,
        "items": {
            "L01": {"speaker": "A", "turns": "one speaker"},
            "L02": {"speaker": "B", "turns": "two or more"},
            "L03": {"speaker": "B", "turns": "one speaker"},  # wrong: S1 maps to A
            "L04": {"speaker": "unsure", "turns": "two or more"},  # missed turn
        },
    }
    result = {
        "runId": "r",
        "configs": {
            "auto": {"speakers": 2, "minorClusters": 0, "clusteringMs": 5},
            "auto-r2": {"clusteringMs": 2},
            "auto-r3": {"clusteringMs": 3},
        },
        "performance": {"processingMs": 1, "minutesPerAudioHour": 1.5, "peakMemoryBytes": 10},
    }
    scored = bench.score(key, review, result)
    auto = scored["configs"]["auto"]
    assert auto["speakerCount"] == {
        "reviewed": 3,
        "predicted": 2,
        "comparison": "compared",
        "error": -1,
        "minorClusters": 0,
    }
    unknown = bench.score(key, review | {"total": None}, result)["configs"]["auto"]
    assert unknown["speakerCount"]["comparison"].startswith("omitted")
    assert unknown["speakerCount"]["error"] is None
    assert auto["dominantLine"]["all"]["correct"] == 2 and auto["dominantLine"]["all"]["total"] == 3
    assert auto["dominantLine"]["long"]["accuracy"] == 1.0
    assert auto["dominantLine"]["short"]["accuracy"] == 0.0
    # One line per stratum in this episode, so the estimate is the mean of reviewed strata.
    assert auto["dominantLine"]["episodeEstimate"]["all"]["estimate"] == round(2 / 3, 4)
    assert auto["dominantLine"]["episodeEstimate"]["all"]["populationCovered"] == 0.75
    assert auto["mixedFlag"] == {
        "truePositive": 1,
        "falsePositive": 0,
        "falseNegative": 1,
        "trueNegative": 2,
        "precision": 1.0,
        "recall": 0.5,
    }
    assert scored["proposedTargets"]["status"] == "proposed, not established"
    assert scored["performance"]["primaryProcessingMs"] == 1
    assert scored["performance"]["evaluationOverheadMs"] == 5
    assert scored["proposedTargets"]["longLineAccuracy"]["measure"] == (
        "dominantLine.episodeEstimate.long (exploratory)"
    )
    assert auto["dominantLine"]["episodeEstimate"]["long"]["status"] == "exploratory"
    # Support per stratum, with unsure answers and unassigned lines reported, not hidden.
    assert auto["dominantLine"]["byStratum"]["difficult"] == {
        "inEpisode": 1,
        "picked": 1,
        "speakerAnswered": 0,
        "unsureOrBlank": 1,
        "unassigned": 0,
        "correct": 0,
        "total": 0,
        "accuracy": None,
        "wilson95": None,
    }
    assert auto["dominantLine"]["byStratum"]["short"]["speakerAnswered"] == 1
    assert auto["dominantLine"]["unassigned"] == 0
    assert auto["dominantLine"]["unassignedInEpisode"] == 0


# --- the whole run, end to end, with fakes --------------------------------------------------------


def _transcript(n: int) -> dict:
    return {
        "schemaVersion": "1.8",
        "episodeId": EPISODE,
        "language": "zh-CN",
        "script": "simplified",
        "durationMs": n * LINE_MS,
        "segments": [
            {
                "id": f"seg-{i + 1:04d}",
                "index": i,
                "startMs": i * LINE_MS,
                "endMs": (i + 1) * LINE_MS,
                "text": f"这是虚构的第{i + 1}句。",
                "speaker": None,
                "confidence": None,
                "tokens": None,
            }
            for i in range(n)
        ],
        "provenance": {
            "kind": "asr",
            "provider": "funasr",
            "model": "invented",
            "createdAt": "2026-10-07T00:00:00.000Z",
        },
    }


def _episode(tmp_path: Path, n: int = 120, kind: str = "asr") -> Storage:
    storage = Storage(tmp_path / "pebble")
    storage.ensure()
    Database(storage.db_path).migrate()
    episode_dir = storage.root / "episodes" / EPISODE
    (episode_dir / "work").mkdir(parents=True)
    (episode_dir / "source.wav").write_bytes(b"not used: normalized.wav is reused")
    with wave.open(str(episode_dir / "work" / "normalized.wav"), "wb") as wav:
        wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        wav.writeframes(b"\x00\x01" * (n * LINE_MS * 16))
    transcript = _transcript(n)
    transcript["provenance"]["kind"] = kind
    stamp = "2026-10-07T00:00:00.000Z"
    with Database(storage.db_path).tx() as conn:
        conn.execute(
            "INSERT INTO episodes VALUES "
            "(?, 'Invented', 'x.wav', ?, 'audio/wav', ?, 'zh-CN', ?, ?)",
            (EPISODE, f"episodes/{EPISODE}/source.wav", n * LINE_MS, stamp, stamp),
        )
        conn.execute(
            """INSERT INTO jobs (id, episode_id, status, attempt, provider_id, provider_kind,
                                 created_at, updated_at)
               VALUES ('job-1', ?, 'completed', 1, 'funasr', 'asr', ?, ?)""",
            (EPISODE, stamp, stamp),
        )
        conn.execute(
            "INSERT INTO transcripts VALUES (?, 'job-1', 1, ?, ?)",
            (EPISODE, json.dumps(transcript, ensure_ascii=False), stamp),
        )
    return storage


def _fake_embedder(calls: dict):
    numpy = pytest.importorskip("numpy")

    def load(storage: Storage):
        calls["loads"] = calls.get("loads", 0) + 1

        def embed(windows):
            calls["windows"] = calls.get("windows", 0) + len(windows)
            assert all(w.shape == (24000,) and w.dtype == numpy.float32 for w in windows)
            return numpy.arange(len(windows) * 192, dtype=numpy.float32).reshape(-1, 192)

        return embed

    return load


def _fake_clusterer(window_lines_ref: list, seen: list):
    def cluster(embeddings, hint, seed):
        # Every configuration must see the same, untouched embeddings; then spoil this copy.
        seen.append((seed, hint, float(embeddings.sum()), embeddings.shape))
        embeddings[:] = 0
        # Invented truth: lines alternate speakers in runs of three; every run agrees.
        return [(line // 3) % 2 for line in window_lines_ref[: len(embeddings)]], "fake-branch"

    return cluster


def _run(storage, *, calls=None, seen=None, **overrides):
    windows_per_line = bench.window_count(LINE_MS)
    line_of_window = [i for i in range(120) for _ in range(windows_per_line)]
    arguments = {
        "hint": 2,
        "lines": 40,
        "seed": 7,
        "embedder": _fake_embedder({} if calls is None else calls),
        "clusterer": _fake_clusterer(line_of_window, [] if seen is None else seen),
        **overrides,
    }
    return bench.run(storage, Settings(data_dir=storage.root), EPISODE, **arguments)


def test_run_writes_only_its_private_folder_and_never_changes_the_episode(tmp_path, monkeypatch):
    pytest.importorskip("funasr.models.campplus.utils")
    storage = _episode(tmp_path)
    digest = hashlib.sha256(storage.db_path.read_bytes()).hexdigest()
    windows_per_line = bench.window_count(LINE_MS)
    monkeypatch.setattr(
        bench, "normalize", lambda *a, **k: pytest.fail("normalized.wav should be reused")
    )
    calls: dict = {}
    seen: list = []

    directory = _run(storage, calls=calls, seen=seen)

    assert hashlib.sha256(storage.db_path.read_bytes()).hexdigest() == digest
    assert sorted(p.name for p in directory.iterdir()) == ["key.json", "result.json", "review.md"]
    assert all(stat.S_IMODE(p.stat().st_mode) == 0o600 for p in directory.iterdir())
    assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    result = json.loads((directory / "result.json").read_text(encoding="utf-8"))
    key = json.loads((directory / "key.json").read_text(encoding="utf-8"))
    for numbers_only in (result, key):
        assert "虚构" not in json.dumps(numbers_only, ensure_ascii=False)
    assert result["status"] == "completed"
    assert result["audio"] == "reused"

    # One embedding pass, reused by every clustering configuration.
    windows = 120 * windows_per_line
    assert calls == {"loads": 1, "windows": windows}
    assert result["windows"] == windows and result["embeddingPasses"] == 1
    assert len(seen) == 4 and len({(total, shape) for _, _, total, shape in seen}) == 1

    # Distinct, recorded seeds: auto 7/8/9, hint 7.
    assert result["settings"]["autoSeeds"] == [7, 8, 9]
    assert result["settings"]["hintSeed"] == 7
    assert [(seed, hint) for seed, hint, _, _ in seen] == [(7, None), (8, None), (9, None), (7, 2)]
    assert {n: c["seed"] for n, c in result["configs"].items()} == {
        "auto": 7,
        "auto-r2": 8,
        "auto-r3": 9,
        "hint": 7,
    }

    # Actual counts and the branch that actually ran, beside the threshold-based expectation.
    assert all(c["windows"] == windows for c in result["configs"].values())
    assert result["configs"]["hint"]["path"] == "fake-branch"
    assert result["configs"]["hint"]["expectedPath"] == "spectral"
    assert result["episode"]["windowsFromLineTimes"] == windows

    assert result["configs"]["auto"]["speakers"] == 2
    assert result["configs"]["auto-r2"]["agreementWithAuto"] == 1.0
    assert result["performance"]["peakMemoryBytes"] > 0
    assert sum(result["selection"].values()) == 40
    assert sum(result["strata"].values()) == 120
    assert all(line["stratum"] in bench.STRATUM_ORDER for line in key["lines"])
    speakers = [line["auto"]["speaker"] for line in key["lines"]]
    assert speakers[:7] == ["S1", "S1", "S1", "S2", "S2", "S2", "S1"]
    assert [line["segmentId"] for line in key["lines"]] == [f"seg-{i + 1:04d}" for i in range(120)]
    sheet = (directory / "review.md").read_text(encoding="utf-8")
    assert sheet.count("### L") == 40 and "S1" not in sheet
    assert str(storage.work_dir(EPISODE) / "normalized.wav") in sheet


def test_temporary_normalized_audio_is_deleted_and_replays_use_the_source(tmp_path, monkeypatch):
    pytest.importorskip("funasr.models.campplus.utils")
    storage = _episode(tmp_path)
    reused = storage.work_dir(EPISODE) / "normalized.wav"
    good = reused.read_bytes()
    reused.write_bytes(b"not a wav")  # forces a fresh, temporary normalization
    made: list[Path] = []

    def fake_normalize(source, target, *, ffmpeg):
        target.write_bytes(good)
        made.append(target)
        return 120 * LINE_MS

    monkeypatch.setattr(bench, "normalize", fake_normalize)
    directory = _run(storage)
    assert made and made[0].parent == directory and not made[0].exists()
    assert sorted(p.name for p in directory.iterdir()) == ["key.json", "result.json", "review.md"]
    result = json.loads((directory / "result.json").read_text(encoding="utf-8"))
    assert result["audio"] == "normalized-temporarily" and "normalizeMs" in result["timingsMs"]
    sheet = (directory / "review.md").read_text(encoding="utf-8")
    assert str(storage.root / "episodes" / EPISODE / "source.wav") in sheet


@pytest.mark.parametrize(
    ("overrides", "status", "error"),
    [
        ({"deadline_at": 0.0}, "timed_out", bench.DeadlineExceeded),
        (
            {"embedder": lambda storage: (_ for _ in ()).throw(RuntimeError())},
            "failed",
            RuntimeError,
        ),
    ],
    ids=["deadline", "failure"],
)
def test_a_stopped_run_removes_its_files_and_records_why(tmp_path, overrides, status, error):
    pytest.importorskip("funasr.models.campplus.utils")
    storage = _episode(tmp_path)
    with pytest.raises(error):
        _run(storage, **overrides)
    (directory,) = (storage.root / "benchmarks" / "diarize").iterdir()
    assert [p.name for p in directory.iterdir()] == ["result.json"]
    record = json.loads((directory / "result.json").read_text(encoding="utf-8"))
    assert record["status"] == status and record["stage"]


def test_the_parent_kills_a_child_that_overruns_its_deadline_and_cleans_up(tmp_path):
    storage = _episode(tmp_path, n=5)
    started = time.monotonic()
    with pytest.raises(bench.DiarizeError, match="killed"):
        bench.run_bounded(
            storage,
            Settings(data_dir=storage.root),
            EPISODE,
            hint=None,
            lines=50,
            seed=7,
            deadline_minutes=5,
            # A stand-in child that leaves a partial file behind and never finishes.
            command=[
                sys.executable,
                "-c",
                "import json, os, sys, time; spec = json.loads(sys.argv[1]); "
                "d = os.path.join(os.environ['PEBBLE_DATA_DIR'], 'benchmarks', 'diarize', "
                "spec['runId']); open(os.path.join(d, 'normalized.wav'), 'w').write('x'); "
                "assert os.environ['PYTHONDONTWRITEBYTECODE'] == '1'; "
                "c = os.environ['NUMBA_CACHE_DIR']; "
                "assert os.path.dirname(c) == d, c; "
                "os.makedirs(c); open(os.path.join(c, 'f.nbi'), 'w').write('x'); "
                "time.sleep(600)",
            ],
            grace_seconds=-299.0,  # kill one second after starting
        )
    assert time.monotonic() - started < 30
    (directory,) = (storage.root / "benchmarks" / "diarize").iterdir()
    assert [p.name for p in directory.iterdir()] == ["result.json"]
    record = json.loads((directory / "result.json").read_text(encoding="utf-8"))
    assert record["status"] == "killed_at_deadline"


def test_the_deadline_is_bounded():
    with pytest.raises(bench.DiarizeError, match="between 5 and 60 minutes"):
        bench.check_arguments(None, 50, 120)
    bench.check_arguments(None, 50, bench.DEFAULT_DEADLINE_MINUTES)


def test_dry_run_plan_and_refusals_change_nothing(tmp_path):
    storage = _episode(tmp_path, n=60)
    digest = hashlib.sha256(storage.db_path.read_bytes()).hexdigest()
    plan = bench.plan(bench.load_episode(storage, EPISODE), 2)
    assert plan["windowsFromLineTimes"] == 60 * bench.window_count(LINE_MS)
    assert plan["expectedAutoPath"] == "spectral" and plan["expectedHintPath"] == "spectral"
    episode = bench.load_episode(storage, EPISODE)
    assert bench.audio_status(storage, episode) == {
        "sourceAvailable": True,
        "normalizedWav": "reusable",
    }
    (storage.work_dir(EPISODE) / "normalized.wav").write_bytes(b"not a wav")
    assert bench.audio_status(storage, episode)["normalizedWav"] == "unusable"
    with pytest.raises(bench.DiarizeError, match="between 40 and 60"):
        bench.run(storage, Settings(data_dir=storage.root), EPISODE, hint=None, lines=10, seed=7)
    with pytest.raises(bench.DiarizeError, match="between 1 and 15"):
        bench.run(storage, Settings(data_dir=storage.root), EPISODE, hint=40, lines=50, seed=7)
    with pytest.raises(bench.DiarizeError, match="no completed transcript"):
        bench.load_episode(storage, "ep-ffffffffffff")
    assert hashlib.sha256(storage.db_path.read_bytes()).hexdigest() == digest
    assert not (storage.root / "benchmarks").exists()


def test_mock_transcripts_and_missing_databases_are_refused(tmp_path):
    storage = _episode(tmp_path, n=5, kind="mock")
    with pytest.raises(bench.DiarizeError, match="only real"):
        bench.load_episode(storage, EPISODE)
    empty = Storage(tmp_path / "empty")
    with pytest.raises(bench.DiarizeError, match="No Pebble database"):
        bench.load_episode(empty, EPISODE)
    assert not empty.db_path.exists()


def test_the_real_embedder_refuses_unverified_weights_before_importing_funasr(tmp_path):
    storage = Storage(tmp_path / "pebble")
    with pytest.raises(bench.DiarizeError, match="verify --speaker"):
        bench.campplus_embedder(storage)


def test_the_child_entry_point_starts_and_refuses_without_loading_a_model(tmp_path):
    import subprocess

    storage = _episode(tmp_path, n=5)
    spec = {
        "episode": "ep-ffffffffffff",  # no such episode: refused before any model or audio
        "hint": None,
        "lines": 50,
        "seed": 7,
        "runId": "20261007T000000Z-ep-ffffffffffff",
        "deadlineAt": time.time() + 60,
    }
    completed = subprocess.run(
        [sys.executable, "-m", "pebble_worker.bench.diarize_child", json.dumps(spec)],
        env={**os.environ, "PEBBLE_DATA_DIR": str(storage.root)},
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert completed.returncode == 2
    assert json.loads(completed.stdout) == {"error": "DiarizeError"}
    assert "funasr" not in completed.stderr.lower()


# --- targeted review of unmatched clusters (invented key and ticks only) ------------------------


def _targeted_run(tmp_path: Path):
    storage = Storage(tmp_path / "pebble")
    run_id = f"20261007T000000Z-{EPISODE}"
    directory = bench.create_run_dir(storage, run_id)
    work = storage.root / "episodes" / EPISODE / "work"
    work.mkdir(parents=True)
    (work / "normalized.wav").write_bytes(b"only its presence is checked")
    speakers = ["S1"] * 3 + ["S2"] * 60 + ["S3"] * 30 + ["S4"] * 4
    speakers = [speakers[(i * 37) % len(speakers)] for i in range(len(speakers))]  # interleave
    key = {
        "lines": [
            {
                "segmentId": f"seg-{i + 1:04d}",
                "startMs": i * 1000,
                "endMs": i * 1000 + 900,
                "auto": {"speaker": sp},
            }
            for i, sp in enumerate(speakers)
        ],
    }
    by_speaker = {
        sp: [line["segmentId"] for line in key["lines"] if line["auto"]["speaker"] == sp]
        for sp in ("S1", "S2", "S3", "S4")
    }
    reviewed = [("S2", "B")] * 4 + [("S3", "A")] * 3 + [("S1", "A"), ("S4", "B")]
    used = {sp: 0 for sp in by_speaker}
    key["picks"] = []
    sheet = ["- Speakers in the whole episode (number): ", ""]
    for n, (sp, letter) in enumerate(reviewed, start=1):
        key["picks"].append(
            {"item": f"L{n:02d}", "segmentId": by_speaker[sp][used[sp]], "stratum": "spread"}
        )
        used[sp] += 1
        sheet += [
            f"### L{n:02d} · x",
            "",
            f"- Speaker: [x] {letter}",
            "- Turns: [x] one speaker",
            "",
        ]
    (directory / "key.json").write_text(json.dumps(key), encoding="utf-8")
    (directory / "review.md").write_text("\n".join(sheet), encoding="utf-8")
    (directory / "result.json").write_text(
        json.dumps({"episode": {"id": EPISODE}}), encoding="utf-8"
    )
    return storage, run_id, directory, key


def test_targeted_review_samples_only_unreviewed_lines_of_unmatched_clusters(tmp_path):
    storage, run_id, directory, key = _targeted_run(tmp_path)
    db_absent = not storage.db_path.exists()
    counts = bench.prepare_targeted(storage, run_id)
    # S1 has 3 lines (1 reviewed) and S4 has 4 (1 reviewed): every remaining line is taken.
    assert counts == {"clusters": 2, "items": 5, "perCluster": {"S1": 2, "S4": 3}}
    targeted = json.loads((directory / "targeted-key.json").read_text(encoding="utf-8"))
    assert targeted["clusters"] == ["S1", "S4"]
    reviewed = {p["segmentId"] for p in key["picks"]}
    speakers = {line["segmentId"]: line["auto"]["speaker"] for line in key["lines"]}
    assert all(i["segmentId"] not in reviewed for i in targeted["items"])
    assert all(speakers[i["segmentId"]] == i["cluster"] for i in targeted["items"])
    starts = [i["startMs"] for i in targeted["items"]]
    assert starts == sorted(starts)  # interleaved in time, not grouped by cluster
    sheet = (directory / "targeted-review.md").read_text(encoding="utf-8")
    assert re.search(r"\bS\d\b", sheet) is None and "cluster" not in sheet.lower()
    assert sheet.count("### T") == 5 and "[ ] another voice" in sheet
    assert not storage.db_path.exists() and db_absent  # no database is created or read
    with pytest.raises(bench.DiarizeError, match="never overwritten"):
        bench.prepare_targeted(storage, run_id)


def test_targeted_selection_spreads_across_a_large_cluster():
    key = {
        "lines": [
            {"segmentId": f"s{i}", "startMs": i, "endMs": i + 1, "auto": {"speaker": "S1"}}
            for i in range(50)
        ],
        "picks": [{"segmentId": "s0"}],
    }
    chosen = bench.select_targeted(key, ["S1"], per_cluster=5, seed=7)
    assert len(chosen) == 5 and 0 not in [i for i, _ in chosen]
    assert {i * 5 // 50 for i, _ in chosen} == {0, 1, 2, 3, 4}


def test_targeted_score_counts_answers_per_cluster(tmp_path):
    storage, run_id, directory, _ = _targeted_run(tmp_path)
    bench.prepare_targeted(storage, run_id)
    targeted = json.loads((directory / "targeted-key.json").read_text(encoding="utf-8"))
    sheet = (directory / "targeted-review.md").read_text(encoding="utf-8")
    answers = {}
    for n, item in enumerate(targeted["items"]):
        choice = ("A", "another voice", "unsure", None)[n % 4]
        answers[item["item"]] = choice
        if choice:
            head = f"### {item['item']} "
            at = sheet.index(head)
            end = sheet.find("### T", at + 1)
            end = len(sheet) if end == -1 else end
            sheet = (
                sheet[:at]
                + sheet[at:end].replace(f"[ ] {choice}", f"[x] {choice}", 1)
                + sheet[end:]
            )
    (directory / "targeted-review.md").write_text(sheet, encoding="utf-8")
    scored = bench.score_targeted(storage, run_id)
    assert scored["kind"].startswith("targeted diagnostic")
    expected = {
        c: {"A": 0, "B": 0, "another voice": 0, "unsure": 0, "blank": 0} for c in ("S1", "S4")
    }
    for item in targeted["items"]:
        expected[item["cluster"]][answers[item["item"]] or "blank"] += 1
    assert scored["clusters"] == expected
    assert (directory / "targeted-score.json").is_file()
