"""
`pebble-worker bench` with a fake AutoModel: no FunASR, torch or weights, and no real
recordings. All audio is generated tones; all text is invented. Every artifact goes to a
temporary data directory that is deleted when each test ends.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from test_funasr_provider import RUNTIME, SPECS, install_models

from pebble_worker.bench import analysis
from pebble_worker.bench.corpus import CorpusError, find_clip, load_corpus
from pebble_worker.bench.paths import create_run_dir, run_dir
from pebble_worker.bench.report import load_runs, render_markdown, summarize
from pebble_worker.bench.results import RunResult
from pebble_worker.bench.review import TEXT_OPTIONS, read_ratings
from pebble_worker.bench.runner import BenchInput, chunking_for, warm_session
from pebble_worker.cli import main
from pebble_worker.config import Settings
from pebble_worker.contract import parse_transcript
from pebble_worker.errors import FailureCode, StorageAccessError
from pebble_worker.pipeline.chunk import ChunkPlan
from pebble_worker.providers.funasr import FunASRProvider
from pebble_worker.storage import Storage

INVENTED = "这是一句测试。"


@pytest.fixture
def data_dir(tmp_path):
    """A throwaway Pebble data directory, removed (and checked removed) after the test."""
    root = tmp_path / "pebble"
    yield root
    shutil.rmtree(root, ignore_errors=True)
    assert not root.exists()


@pytest.fixture
def storage(data_dir):
    storage = Storage(data_dir)
    storage.ensure()
    return storage


class SentencePerChunk:
    def __init__(self, text=INVENTED):
        self.text = text

    def generate(self, *, input, **kwargs):
        duration = len(input) // 16
        if not self.text:
            return [{"key": "c", "text": "", "timestamp": []}]
        return [
            {
                "key": "c",
                "text": self.text,
                "timestamp": [],
                "sentence_info": [
                    {"text": self.text, "start": 100, "end": max(200, duration - 100)}
                ],
            }
        ]


class Exploding:
    def generate(self, *, input, **kwargs):
        raise RuntimeError("boom")


def fake_provider(storage, model=None):
    install_models(storage)
    return FunASRProvider(
        storage,
        loader=lambda paths: model or SentencePerChunk(),
        runtime=lambda: RUNTIME,
        reader=lambda chunk: [0.0] * (chunk.duration_ms * 16),
        models=SPECS,
    )


def tone_input(audio, **overrides):
    values = dict(
        clip_id="clip-a",
        label="Clip A",
        kind="corpus",
        source=audio["tone_gaps"],
        reference_text=None,
        reference_label=None,
    )
    values.update(overrides)
    return BenchInput(**values)


def run_warm(storage, audio, targets=(3,), model=None, **input_overrides):
    settings = Settings(data_dir=storage.root)
    imports = []
    directories = warm_session(
        storage,
        settings,
        tone_input(audio, **input_overrides),
        list(targets),
        provider=fake_provider(storage, model),
        import_runtime=lambda: imports.append(1),
        seed=7,
    )
    return directories, imports


# --- a whole run ------------------------------------------------------------------------------


def test_warm_session_writes_private_results_transcript_and_review(storage, audio):
    directories, imports = run_warm(storage, audio, targets=(3, 5))
    assert imports == [1]  # setup once per warm session
    assert [d.parent for d in directories] == [storage.root / "benchmarks" / "runs"] * 2
    for directory in directories:
        assert {p.name for p in directory.iterdir()} == {
            "result.json",
            "transcript.json",
            "review.md",
            "normalized.wav",
        }  # chunk files are removed after the run
        assert directory.stat().st_mode & 0o777 == 0o700
        for path in directory.iterdir():
            assert path.stat().st_mode & 0o777 == 0o600
        result = RunResult.model_validate(json.loads((directory / "result.json").read_text()))
        assert result.status == "completed" and result.mode == "warm"
        assert result.setup.scope == "shared-warm-session"
        job = result.job
        assert all(
            v is not None
            for v in (
                job.probe_ms,
                job.normalize_ms,
                job.chunking_ms,
                job.transcription_ms,
                job.merge_ms,
            )
        )
        assert job.real_time_factor is not None and job.real_time_factor > 0
        assert result.memory.rss_max_bytes > 0
        assert result.clip.duration_ms == 14000
        assert result.chunks["count"] >= 2
        assert result.segments["count"] == result.chunks["count"]
        assert result.network == {"attempts": 0}
        assert parse_transcript(json.loads((directory / "transcript.json").read_text())).ok

    first = RunResult.model_validate(json.loads((directories[0] / "result.json").read_text()))
    assert first.chunking.target_seconds == 3 and first.chunking.min_seconds == 2
    assert first.chunking.max_seconds == 5 and not first.chunking.is_worker_default


def test_results_never_contain_text_or_source_paths(storage, audio):
    [directory], _ = run_warm(storage, audio)
    raw = (directory / "result.json").read_text()
    assert INVENTED not in raw
    assert str(audio["tone_gaps"]) not in raw and "tone_gaps" not in raw
    assert INVENTED in (directory / "review.md").read_text()  # private checklist only


def test_no_speech_and_failures_are_recorded_not_hidden(storage, audio):
    [silent], _ = run_warm(storage, audio, model=SentencePerChunk(text=""))
    assert json.loads((silent / "result.json").read_text())["status"] == "no-speech"

    other = Storage(storage.root.parent / "other")
    other.ensure()
    [broken], _ = run_warm(other, audio, model=Exploding())
    result = json.loads((broken / "result.json").read_text())
    assert result["status"] == "failed"
    assert result["failure"] == {"stage": "transcribing", "code": FailureCode.PROVIDER_ERROR.value}
    assert result["segments"] is None and not (broken / "review.md").exists()
    shutil.rmtree(other.root)


def test_cer_is_only_computed_with_a_reference(storage, audio):
    [without], _ = run_warm(storage, audio)
    assert json.loads((without / "result.json").read_text())["cer"] is None
    [with_ref], _ = run_warm(
        storage,
        audio,
        targets=(5,),
        reference_text=INVENTED * 3,
        reference_label="Clip A reference",
    )
    cer = json.loads((with_ref / "result.json").read_text())["cer"]
    assert cer["kind"] == "reference" and cer["referenceLabel"] == "Clip A reference"
    assert 0 <= cer["value"] <= 1


def test_default_chunking_is_the_workers_current_setting(tmp_path):
    settings = Settings(data_dir=tmp_path)
    assert chunking_for(None, settings) == settings.chunking
    config = chunking_for(240, settings)
    assert (config.target_seconds, config.min_seconds, config.max_seconds) == (240, 192, 384)


# --- analysis ---------------------------------------------------------------------------------


def _transcript(spans, duration=60_000):
    segments = [
        {
            "id": f"seg-{i + 1:04d}",
            "index": i,
            "startMs": s,
            "endMs": e,
            "text": f"句子{i}",
            "speaker": None,
            "confidence": None,
            "tokens": None,
            "chunkIndex": 0,
            "review": {"flags": list(flags)},
        }
        for i, (s, e, flags) in enumerate(spans)
    ]
    payload = {
        "schemaVersion": "1.5",
        "episodeId": "ep-000000000000",
        "language": "zh-CN",
        "script": "simplified",
        "durationMs": duration,
        "segments": segments,
        "provenance": {
            "kind": "asr",
            "provider": "funasr",
            "model": "m",
            "createdAt": "2026-10-03T00:00:00Z",
        },
    }
    result = parse_transcript(payload)
    assert result.ok, result.issues
    return result.data


def test_boundary_analysis_is_timing_only():
    plans = [
        ChunkPlan(0, 0, 10_000, "hard"),
        ChunkPlan(1, 10_000, 20_000, "silence"),
        ChunkPlan(2, 20_000, 30_000, "end"),
    ]
    transcript = _transcript(
        [(8_000, 9_850, ()), (10_100, 12_000, ()), (14_000, 19_000, ()), (21_000, 25_000, ())],
        duration=30_000,
    )
    rows = analysis.boundary_analysis(plans, transcript)
    assert [r["kind"] for r in rows] == ["forced", "silence"]
    assert rows[0]["segmentsEndingNear"] == 1 and rows[0]["segmentsStartingNear"] == 1
    assert rows[0]["gapAcrossCutMs"] == 250
    assert rows[1]["gapAcrossCutMs"] == 2000
    summary = analysis.boundary_summary(rows)
    assert summary["forced"]["cuts"] == 1 and summary["silence"]["cuts"] == 1
    assert not any("text" in key.lower() or "duplicat" in key.lower() for key in rows[0])


def test_review_selection_priorities_and_cap():
    spans = [(i * 2000, i * 2000 + 1500, ()) for i in range(40)]
    spans[2] = (4000, 5500, ("timestamp_alignment_anomaly",))  # not next to a cut
    spans[5] = (10_000, 10_500, ("short_fragment",))
    plans = [ChunkPlan(i, i * 8000, (i + 1) * 8000, "hard") for i in range(10)]
    plans[-1] = ChunkPlan(9, 72_000, 80_000, "end")
    picks = analysis.select_for_review(plans, _transcript(spans, 80_000), seed=7)
    assert len(picks) == analysis.REVIEW_CAP
    reasons = [p.reasons[0] for p in picks]
    assert reasons.count("forced-cut-adjacent") == 18  # 9 forced cuts, 2 neighbours each
    assert "timestamp-alignment-anomaly" in reasons and "long-or-short" in reasons
    assert "control" not in reasons  # controls come last when the cap is reached
    assert [p.segment.start_ms for p in picks] == sorted(p.segment.start_ms for p in picks)


def test_review_selection_includes_five_seeded_controls():
    spans = [(i * 2000, i * 2000 + 1500, ()) for i in range(30)]
    plans = [ChunkPlan(0, 0, 60_000, "end")]
    first = analysis.select_for_review(plans, _transcript(spans), seed=3)
    again = analysis.select_for_review(plans, _transcript(spans), seed=3)
    assert [p.reasons for p in first] == [("control",)] * 5
    assert [p.segment.id for p in first] == [p.segment.id for p in again]


@pytest.mark.parametrize(
    ("hyp", "ref", "expected"),
    [
        ("今天天气很好", "今天天气很好", 0.0),
        ("今天天气很好。", "今天，天气很好", 0.0),  # punctuation and spacing don't count
        ("今天天气好", "今天天气很好", round(1 / 6, 4)),
        ("", "今天", 1.0),
        ("abc", "", None),
    ],
)
def test_character_error_rate(hyp, ref, expected):
    assert analysis.character_error_rate(hyp, ref) == expected


# --- review checklist ---------------------------------------------------------------------------


def test_ratings_are_read_back_as_counts_only(storage, audio):
    [directory], _ = run_warm(storage, audio)
    review = directory / "review.md"
    content = review.read_text()
    assert content.count("### R") <= analysis.REVIEW_CAP
    assert "ffplay -nodisp -autoexit -ss " in content
    first = content.replace("[ ] clean", "[x] clean", 1).replace(
        "[ ] minor fix", "[x] minor fix", 1
    )
    first = first.replace("- Correction time (seconds): ", "- Correction time (seconds): 12", 1)
    review.write_text(first)
    ratings = read_ratings(review)
    assert ratings["rated"] == 1
    assert ratings["replayRange"]["clean"] == 1
    assert ratings["textQuality"] == {**dict.fromkeys(TEXT_OPTIONS, 0), "minor fix": 1}
    assert ratings["correctionSeconds"] == {"rated": 1, "total": 12.0}
    assert INVENTED not in json.dumps(ratings)


# --- paths --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad", ["../escape", "20261003T000000Z-clip-a-120s-warm/../x", "clip-a", "", "x/y"]
)
def test_run_ids_cannot_escape_the_runs_directory(storage, bad):
    with pytest.raises(StorageAccessError):
        run_dir(storage, bad)


def test_a_symlinked_benchmarks_directory_is_refused(storage, tmp_path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (storage.root / "benchmarks").symlink_to(elsewhere)
    with pytest.raises(StorageAccessError, match="symlink"):
        create_run_dir(storage, "20261003T000000Z-clip-a-120s-warm")
    assert list(elsewhere.iterdir()) == []


def test_run_directories_are_never_reused(storage):
    create_run_dir(storage, "20261003T000000Z-clip-a-120s-warm")
    with pytest.raises(FileExistsError):
        create_run_dir(storage, "20261003T000000Z-clip-a-120s-warm")


# --- corpus manifest ----------------------------------------------------------------------------


def write_corpus(storage, clips, version=1):
    path = storage.root / "benchmarks" / "corpus.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"schemaVersion": version, "clips": clips}))


def clip_entry(path, **overrides):
    entry = {
        "id": "clip-a",
        "label": "Clip A",
        "path": str(path),
        "durationSeconds": 14,
        "rightsNote": "Recorded by me.",
    }
    entry.update(overrides)
    return entry


def test_corpus_is_required(storage):
    with pytest.raises(CorpusError, match="No benchmark corpus"):
        load_corpus(storage)


def test_valid_corpus_loads(storage, audio):
    write_corpus(storage, [clip_entry(audio["tone_gaps"], difficultyNotes="clean")])
    [clip] = load_corpus(storage)
    assert (clip.id, clip.label, clip.reference_path) == ("clip-a", "Clip A", None)


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda e, a: {**e, "extra": 1}, "invalid"),
        (lambda e, a: {**e, "id": "A"}, "must look like"),
        (lambda e, a: {**e, "path": "relative.m4a"}, "absolute path"),
        (lambda e, a: {**e, "path": "/nonexistent/file.m4a"}, "not a readable file"),
        (lambda e, a: {**e, "rightsNote": "  "}, "rightsNote is required"),
        (lambda e, a: {**e, "durationSeconds": 0}, "invalid"),
        (lambda e, a: {**e, "referencePath": "/nonexistent/ref.txt"}, "not a readable file"),
    ],
)
def test_invalid_corpus_entries_are_refused(storage, audio, mutate, message):
    write_corpus(storage, [mutate(clip_entry(audio["tone_gaps"]), audio)])
    with pytest.raises(CorpusError, match=message) as raised:
        load_corpus(storage)
    assert "/nonexistent" not in str(raised.value)  # errors never echo paths


def test_corpus_files_inside_the_repository_are_refused(storage):
    inside = Path(__file__).resolve()
    write_corpus(storage, [clip_entry(inside)])
    with pytest.raises(CorpusError, match="inside the Pebble repository"):
        load_corpus(storage)


def test_duplicate_clip_ids_are_refused(storage, audio):
    write_corpus(storage, [clip_entry(audio["tone_gaps"]), clip_entry(audio["short"])])
    with pytest.raises(CorpusError, match="unique"):
        load_corpus(storage)


def test_unknown_clip_is_reported(storage, audio):
    write_corpus(storage, [clip_entry(audio["tone_gaps"])])
    with pytest.raises(CorpusError, match="No clip"):
        find_clip(storage, "clip-z")


# --- CLI ----------------------------------------------------------------------------------------


@pytest.fixture
def env(monkeypatch, data_dir):
    monkeypatch.setenv("PEBBLE_DATA_DIR", str(data_dir))
    return data_dir


def test_dry_run_validates_without_transcribing(env, audio, capsys):
    storage = Storage(env)
    storage.ensure()
    write_corpus(storage, [clip_entry(audio["tone_gaps"])])
    code = main(
        ["bench", "run", "--clip", "clip-a", "--chunk", "120", "--chunk", "default", "--dry-run"]
    )
    out = capsys.readouterr().out
    assert code == 0
    assert "Clip A · warm · chunk targets: 120 s, default" in out
    assert str(audio["tone_gaps"]) not in out and "Recorded by me" not in out
    assert not (env / "benchmarks" / "runs").exists()


def test_manifest_duration_must_match_the_file(env, audio, capsys):
    storage = Storage(env)
    storage.ensure()
    write_corpus(storage, [clip_entry(audio["tone_gaps"], durationSeconds=60)])
    assert main(["bench", "run", "--clip", "clip-a", "--chunk", "120", "--dry-run"]) == 2
    assert "doesn't match the file" in capsys.readouterr().out


@pytest.mark.parametrize("bad", ["5", "1000", "fast"])
def test_chunk_targets_are_validated(env, bad, capsys):
    assert main(["bench", "run", "--synthetic", "--chunk", bad, "--dry-run"]) == 2
    assert "between 10 and 900 seconds" in capsys.readouterr().out


def test_report_aggregates_numbers_only(env, audio, capsys):
    storage = Storage(env)
    storage.ensure()
    run_warm(storage, audio, targets=(3, 5))
    capsys.readouterr()
    assert main(["bench", "report"]) == 0
    out = capsys.readouterr().out
    assert INVENTED not in out and str(audio["tone_gaps"]) not in out
    [md] = list((env / "benchmarks" / "reports").glob("report-*.md"))
    [js] = list((env / "benchmarks" / "reports").glob("report-*.json"))
    for path in (md, js):
        assert INVENTED not in path.read_text() and "tone_gaps" not in path.read_text()
        assert path.stat().st_mode & 0o777 == 0o600
    rows = summarize(storage, load_runs(storage))
    assert len(rows) == 2 and "Local measurements on this computer" in render_markdown(rows)


def test_report_with_no_runs(env, capsys):
    assert main(["bench", "report"]) == 1


def test_bench_imports_nothing_heavy():
    import subprocess
    import sys

    code = (
        "import sys, pebble_worker.cli, pebble_worker.bench.commands;"
        "heavy = ('funasr', 'torch', 'modelscope', 'transformers');"
        "print(sorted(m for m in heavy if m in sys.modules))"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "[]"
