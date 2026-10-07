"""
Benchmark-only chunk overlap (M1-B2): ranges, the conservative resolver, `compare`, and the
blinded paired review. Invented text and synthetic tones only; temporary data directories.
"""

from __future__ import annotations

import json
import random
import re
import shutil
import subprocess
import sys
import wave
from itertools import pairwise

import pytest
from test_bench import fake_provider, run_warm, tone_input
from test_funasr_provider import one_sentence_output

from pebble_worker.bench import compare, overlap, paired
from pebble_worker.bench.overlap import ChunkRange, OverlapUnresolved, chunk_ranges, resolve
from pebble_worker.bench.paths import run_dir
from pebble_worker.bench.runner import warm_session
from pebble_worker.cli import main
from pebble_worker.config import Settings
from pebble_worker.errors import StorageAccessError
from pebble_worker.pipeline.chunk import ChunkPlan, write_chunks
from pebble_worker.providers.base import RawSegment
from pebble_worker.storage import Storage

SENTINEL = "示例句子用于测试"  # invented; must never reach results, reports or tallies


@pytest.fixture
def data_dir(tmp_path):
    root = tmp_path / "pebble"
    yield root
    shutil.rmtree(root, ignore_errors=True)
    assert not root.exists()


@pytest.fixture
def storage(data_dir):
    storage = Storage(data_dir)
    storage.ensure()
    return storage


# --- ranges ---------------------------------------------------------------------------------


PLANS = [
    ChunkPlan(0, 0, 150_000, "silence"),
    ChunkPlan(1, 150_000, 300_000, "silence"),
    ChunkPlan(2, 300_000, 420_000, "end"),
]


@pytest.mark.parametrize(
    ("overlap_ms", "audio"),
    [
        (0, [(0, 150_000), (150_000, 300_000), (300_000, 420_000)]),
        (1000, [(0, 150_500), (149_500, 300_500), (299_500, 420_000)]),
        (2000, [(0, 151_000), (149_000, 301_000), (299_000, 420_000)]),
    ],
)
def test_chunk_ranges_share_the_overlap_centred_on_each_cut(overlap_ms, audio):
    ranges = chunk_ranges(PLANS, 420_000, overlap_ms)
    assert [(r.audio_start, r.audio_end) for r in ranges] == audio
    assert [(r.owned_start, r.owned_end) for r in ranges] == [
        (0, 150_000),
        (150_000, 300_000),
        (300_000, 420_000),
    ]  # ownership (and the cuts) never move


def test_ranges_are_clamped_to_the_audio():
    plans = [ChunkPlan(0, 0, 600, "silence"), ChunkPlan(1, 600, 1000, "end")]
    ranges = chunk_ranges(plans, 1000, 2000)
    assert [(r.audio_start, r.audio_end) for r in ranges] == [(0, 1000), (0, 1000)]
    [single] = chunk_ranges([ChunkPlan(0, 0, 5000, "end")], 5000, 2000)
    assert (single.audio_start, single.audio_end) == (0, 5000)


@pytest.mark.parametrize("bad", [-1, 2001])
def test_overlap_is_bounded(bad):
    with pytest.raises(ValueError):
        chunk_ranges(PLANS, 420_000, bad)


def _wav(path, seconds=3):
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(16000)
        out.writeframes(bytes(range(256)) * (seconds * 16000 * 2 // 256))
    return path


def test_context_chunks_are_sample_exact_and_zero_overlap_matches_today(tmp_path):
    source = _wav(tmp_path / "in.wav")
    plans = [ChunkPlan(0, 0, 1000, "silence"), ChunkPlan(1, 1000, 3000, "end")]
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    (tmp_path / "c").mkdir()
    today = write_chunks(source, plans, tmp_path / "a")
    zero = overlap.write_context_chunks(source, chunk_ranges(plans, 3000, 0), tmp_path / "b")
    assert [p.read_bytes() for p in today] == [p.read_bytes() for p in zero]
    wide = overlap.write_context_chunks(source, chunk_ranges(plans, 3000, 2000), tmp_path / "c")
    frames = []
    for path in wide:
        with wave.open(str(path)) as w:
            frames.append(w.getnframes())
    assert frames == [32000, 48000]  # 0–2000 ms and 0–3000 ms (clamped at the start)


# --- resolver -------------------------------------------------------------------------------

TWO = [
    ChunkRange(0, 0, 10_000, 0, 11_000),
    ChunkRange(1, 10_000, 20_000, 9_000, 20_000),
]


def seg(start, end, text):
    return RawSegment(start, end, text)


def texts(resolution):
    return [s.text for chunk in resolution.chunks for s in chunk.segments]


def test_zero_overlap_resolution_returns_the_input_unchanged():
    ranges = chunk_ranges(
        [ChunkPlan(0, 0, 10_000, "silence"), ChunkPlan(1, 10_000, 20_000, "end")], 20_000, 0
    )
    outputs = [
        [seg(0, 4000, "第一句。"), seg(5000, 9000, "第二句。")],
        [seg(500, 3000, "第三句。")],
    ]
    resolution = resolve(ranges, outputs, 20_000)
    assert [c.start_ms for c in resolution.chunks] == [0, 10_000]
    assert [list(c.segments) for c in resolution.chunks] == outputs
    assert resolution.diagnostics["excluded"] == dict.fromkeys(overlap.EXCLUSION_REASONS, 0)


def test_provider_times_are_offset_by_the_chunk_audio_start():
    resolution = resolve(TWO, [[], [seg(1500, 4000, "后面。")]], 20_000)
    [_, chunk1] = resolution.chunks
    assert chunk1.start_ms == 9_000 and chunk1.segments[0].start_ms == 1500  # → 10,500 ms


def test_equivalent_duplicates_keep_the_one_farther_from_its_edge():
    left = seg(8000, 10_800, "今天天气很好。")  # mid 9400: 1600 ms from the left audio end
    right = seg(0, 1800, "今天天气很好")  # mid 9900 absolute: 900 ms from the right audio start
    resolution = resolve(TWO, [[left], [right]], 20_000)
    assert texts(resolution) == ["今天天气很好。"]
    assert resolution.diagnostics["excluded"]["duplicateRemoved"] == 1
    assert resolution.diagnostics["perCut"][0]["chosenLeft"] == 1
    assert resolution.diagnostics["reconciled"]


def test_conflicting_text_keeps_the_farther_candidate_unchanged_and_flags_it():
    left = seg(9000, 10_900, "我们去公园。")  # mid 9950: 1050 from its edge
    right = seg(500, 2500, "我们去学校散步。")  # 10,500 absolute mid: 1500 from its edge
    resolution = resolve(TWO, [[left], [right]], 20_000)
    assert texts(resolution) == ["我们去学校散步。"]  # the right one, as recognized
    assert resolution.diagnostics["excluded"]["conflictLoser"] == 1
    assert resolution.diagnostics["perCut"][0]["chosenRight"] == 1
    assert resolution.diagnostics["perCut"][0]["conflictTextLengths"] == [
        {"kept": 7, "excluded": 5}
    ]
    assert [i["kind"] for i in resolution.review_items] == ["conflict"]


# Left 9,000–10,900 (mid 9,950: 1,050 ms from its edge) against right 500–2,500 → 9,500–11,500
# (mid 10,500: 1,500 ms from its edge): without content rules the right one wins on distance.
NEAR_LEFT, FAR_RIGHT = (9000, 10_900), (500, 2500)


@pytest.mark.parametrize(
    ("left_text", "right_text", "kept", "reason"),
    [
        ("我们去公园。", "。", "我们去公园。", "punctuationOnlyLoser"),  # content beats distance
        ("，。", "我们去学校。", "我们去学校。", "punctuationOnlyLoser"),  # and distance agrees
        ("。", "？！", "？！", "duplicateRemoved"),  # noqa: RUF001 — both empty: distance decides
        ("我们去公园。", "我们去学校。", "我们去学校。", "conflictLoser"),  # both content: distance
        ("「 」…… ——", "好", "好", "punctuationOnlyLoser"),  # CJK punctuation and spaces only
        ("　、；：", "Ok 2", "Ok 2", "punctuationOnlyLoser"),  # noqa: RUF001 — Latin/digits win
    ],
)
def test_content_beats_punctuation_only_in_conflicts(left_text, right_text, kept, reason):
    left, right = seg(*NEAR_LEFT, left_text), seg(*FAR_RIGHT, right_text)
    resolution = resolve(TWO, [[left], [right]], 20_000)
    assert texts(resolution) == [kept]
    diagnostics = resolution.diagnostics
    assert diagnostics["excluded"][reason] == 1 and sum(diagnostics["excluded"].values()) == 1
    assert diagnostics["perCut"][0][reason] == 1 and diagnostics["reconciled"]
    assert diagnostics["resolverVersion"] == overlap.RESOLVER_VERSION == 2
    if reason == "punctuationOnlyLoser":
        assert resolution.review_items == [] and diagnostics["ambiguous"] == 0


def test_punctuation_rule_keeps_ordering_and_no_overlap():
    left = [seg(6000, 8500, "前面一句。"), seg(*NEAR_LEFT, "左边的内容。")]
    right = [seg(*FAR_RIGHT, "。"), seg(3000, 6000, "后面一句。")]
    resolution = resolve(TWO, [left, right], 20_000)
    absolute = sorted(
        (c.start_ms + s.start_ms, c.start_ms + s.end_ms, s.text)
        for c in resolution.chunks
        for s in c.segments
    )
    assert [t for _, _, t in absolute] == ["前面一句。", "左边的内容。", "后面一句。"]
    assert all(b[0] >= a[1] - overlap.OVERLAP_TOLERANCE_MS for a, b in pairwise(absolute))
    assert resolution.diagnostics["excluded"]["punctuationOnlyLoser"] == 1


def test_equal_edge_distance_falls_back_to_ownership():
    ranges = [ChunkRange(0, 0, 10_000, 0, 11_000), ChunkRange(1, 10_000, 20_000, 9_000, 20_000)]
    left = seg(9500, 10_000, "相同。")  # mid 9750: 1250 from its edge; owned by chunk 0
    right = seg(1000, 1500, "相同")  # 10,000–10,500: mid 1250 from its edge; owned by chunk 1
    resolution = resolve(ranges, [[left], [right]], 20_000)
    assert len(texts(resolution)) == 2  # not material: they don't overlap in time at all
    tie_left = seg(9600, 10_400, "同样。")  # mid 10,000 → owned by chunk 1, 1000 from edge
    tie_right = seg(600, 1400, "同样")  # same span, mid 10,000, 1000 from edge, owned
    resolution = resolve(ranges, [[tie_left], [tie_right]], 20_000)
    assert [c.index for c in resolution.chunks if c.segments] == [1]  # owner wins the tie
    assert resolution.diagnostics["ambiguous"] == 1


def test_unique_foreign_segments_are_kept_and_counted():
    early = seg(100, 700, "补上的话。")  # chunk 1 audio starts at 9000: lies in chunk 0's span
    resolution = resolve(TWO, [[seg(2000, 8000, "前面的话。")], [early]], 20_000)
    assert "补上的话。" in texts(resolution)
    assert resolution.diagnostics["foreignOrphanKept"] == 1
    assert resolution.diagnostics["excluded"] == dict.fromkeys(overlap.EXCLUSION_REASONS, 0)


def test_small_overlaps_are_kept_but_larger_unresolved_overlaps_fail_the_run():
    touching = resolve(TWO, [[seg(8000, 10_050, "左边。")], [seg(1000, 3000, "右边。")]], 20_000)
    assert len(texts(touching)) == 2  # 50 ms overlap: within tolerance
    with pytest.raises(OverlapUnresolved) as raised:
        resolve(TWO, [[seg(6000, 10_500, "很长的左边一句。")], [seg(1000, 4000, "右边。")]], 20_000)
    assert raised.value.count == 1 and raised.value.diagnostics["unresolvedOverlaps"] == 1


def test_possible_repeats_are_flagged_never_removed():
    left = seg(7000, 9800, "这是一个很长的句子。")
    right = seg(1500, 4000, "一个很长的句子后面")  # shares 6 normalized characters
    resolution = resolve(TWO, [[left], [right]], 20_000)
    assert len(texts(resolution)) == 2
    assert resolution.diagnostics["possibleRepeatAcrossCut"] == 1
    short = resolve(TWO, [[left], [seg(1500, 4000, "很长的句子")]], 20_000)  # only 5
    assert short.diagnostics["possibleRepeatAcrossCut"] == 0


def test_a_candidate_overlapping_two_kept_segments_is_ambiguous():
    left = [seg(8000, 9000, "一。"), seg(9100, 10_900, "二三四五六。")]
    right = [seg(0, 1500, "七八九")]  # 9000–10,500: overlaps the second (and touches the first)
    resolution = resolve(TWO, [left, right], 20_000)
    assert resolution.diagnostics["reconciled"]
    assert sum(resolution.diagnostics["excluded"].values()) == 1


def test_segments_crossing_the_cut_are_resolved_like_any_other():
    crossing = seg(9500, 10_600, "跨过去。")  # left chunk, crosses 10,000
    resolution = resolve(TWO, [[crossing], [seg(2000, 5000, "后面。")]], 20_000)
    assert texts(resolution) == ["跨过去。", "后面。"]


def test_random_inputs_always_reconcile_and_never_invent_text():
    rng = random.Random(11)
    for _ in range(300):
        outputs = []
        for chunk in TWO:
            length = chunk.audio_end - chunk.audio_start
            cursor, segments = 0, []
            while cursor < length - 400:
                start = cursor + rng.randint(0, 600)
                end = min(length, start + rng.randint(300, 2500))
                segments.append(seg(start, end, rng.choice(["甲乙丙。", "丁戊己庚辛。", "壬癸。"])))
                cursor = end + rng.randint(0, 300)
            outputs.append(segments)
        try:
            resolution = resolve(TWO, outputs, 20_000)
        except OverlapUnresolved as error:
            assert error.diagnostics["reconciled"]
            continue
        diagnostics = resolution.diagnostics
        assert diagnostics["reconciled"]
        given = {(s.text, s.start_ms, s.end_ms) for chunk in outputs for s in chunk}
        absolute = []
        for chunk in resolution.chunks:
            for s in chunk.segments:
                assert (s.text, s.start_ms, s.end_ms) in given  # never edited or invented
                absolute.append((chunk.start_ms + s.start_ms, chunk.start_ms + s.end_ms))
        absolute.sort()
        latest = None
        for start, end in absolute:
            if latest is not None:
                assert start >= latest - overlap.OVERLAP_TOLERANCE_MS
            latest = end if latest is None else max(latest, end)
        assert len(set(absolute)) == len(absolute)


def test_diagnostics_never_contain_text():
    left = seg(8000, 10_800, SENTINEL)
    right = seg(0, 1800, SENTINEL + "。")
    resolution = resolve(TWO, [[left], [right]], 20_000)
    dumped = json.dumps([resolution.diagnostics, resolution.review_items], ensure_ascii=False)
    assert SENTINEL not in dumped and "示" not in dumped


# --- whole runs (fake model, synthetic tones) -----------------------------------------------


class StartOfChunk:
    """One invented sentence near the start of whatever audio it receives."""

    def generate(self, *, input, **kwargs):
        duration = len(input) // 16
        end = min(duration - 50, 700)
        return one_sentence_output("c", SENTINEL, 100, end)


def run_overlaps(storage, audio, overlaps, model=None):
    return warm_session(
        storage,
        Settings(data_dir=storage.root),
        tone_input(audio),
        [3],
        provider=fake_provider(storage, model or StartOfChunk()),
        import_runtime=lambda: None,
        seed=7,
        overlaps=overlaps,
    )


def test_overlap_runs_record_numeric_diagnostics_and_share_cuts(storage, audio):
    base, wide = run_overlaps(storage, audio, (0, 2000))
    assert base.name.endswith("-3s-warm") and wide.name.endswith("-3s-warm-o2000")
    r0 = json.loads((base / "result.json").read_text())
    r2 = json.loads((wide / "result.json").read_text())
    assert r0["chunking"]["overlapMs"] == 0 and r0["overlap"] is None
    assert not (base / "overlap.json").exists()
    assert r2["status"] == "completed" and r2["chunking"]["overlapMs"] == 2000
    assert r2["overlap"]["reconciled"] and r2["overlap"]["foreignOrphanKept"] >= 1

    def cuts(result):
        return [(c["cutMs"], c["kind"]) for c in result["boundaries"]["cuts"]]

    assert cuts(r0) == cuts(r2)
    assert [w["window"] for w in r2["cutWindows"]] == [
        f"W{n}" for n in range(1, len(r2["boundaries"]["cuts"]) + 1)
    ]
    for path in (wide / "result.json", wide / "overlap.json"):
        assert SENTINEL not in path.read_text() and path.stat().st_mode & 0o777 == 0o600


def test_unresolved_overlap_fails_the_run_instead_of_trimming(storage, audio):
    from test_bench import SentencePerChunk

    [wide] = run_overlaps(storage, audio, (2000,), model=SentencePerChunk(text=SENTINEL))
    result = json.loads((wide / "result.json").read_text())
    assert result["status"] == "failed"
    assert result["failure"] == {"stage": "resolving", "code": "OVERLAP_UNRESOLVED"}
    assert result["overlap"]["unresolvedOverlaps"] >= 1
    assert not (wide / "transcript.json").exists()


def test_zero_overlap_transcript_matches_the_existing_path(storage, audio):
    [default] = run_warm(storage, audio, model=StartOfChunk())[0]
    other = Storage(storage.root / "other")
    other.ensure()
    [explicit] = run_overlaps(other, audio, (0,))

    def body(path):
        payload = json.loads((path / "transcript.json").read_text())
        payload["provenance"].pop("createdAt")
        return payload

    assert body(default) == body(explicit)


# --- compare and paired review --------------------------------------------------------------


def test_compare_reports_numbers_and_labels_only(storage, audio):
    base, one, two = run_overlaps(storage, audio, (0, 1000, 2000))
    result = compare.compare(storage, base.name, [one.name, two.name])
    assert [v["run"] for v in result["variants"]] == [
        "3 s · overlap 1000 ms",
        "3 s · overlap 2000 ms",
    ]
    for variant in result["variants"]:
        assert variant["valid"] and variant["stability"]["compared"] >= 0
        assert isinstance(variant["classification"], str)
    dumped = json.dumps(result, ensure_ascii=False)
    assert SENTINEL not in dumped and "示" not in dumped
    assert base.name not in dumped  # labels, not run ids
    with pytest.raises(compare.CompareError, match="without overlap"):
        compare.compare(storage, two.name, [one.name])


@pytest.mark.parametrize(
    ("valid", "windows", "improved", "change", "closure", "expected"),
    [
        (False, 3, 3, 0.5, 1.0, "reject: timing validation failed"),
        (True, 1, 1, 0.5, 1.0, "inconclusive: too few comparable windows"),
        (True, 3, 2, 0.25, 0.6, "promising; strong pending human review"),
        (True, 3, 2, 0.25, 0.2, "promising"),
        (True, 4, 2, 0.30, None, "neutral/inconclusive: mixed or small differences"),
        (
            True,
            3,
            0,
            -0.2,
            None,
            "reject-candidate: fewer characters near cuts (pending human review)",
        ),
    ],
)
def test_classification_follows_the_numeric_criteria(
    valid, windows, improved, change, closure, expected
):
    assert compare.classify(valid, windows, improved, change, closure, {"share": 1.0}) == expected
    unstable = compare.classify(True, 3, 2, 0.25, 0.2, {"share": 0.9})
    assert unstable == "promising; unstable away from cuts"


def test_paired_review_is_blinded_and_tallied_as_counts(storage, audio):
    base, one, two = run_overlaps(storage, audio, (0, 1000, 2000))
    review = paired.create(storage, base.name, [one.name, two.name], seed=3)
    path = review.path
    assert review.items >= 1 and not review.pre_fix and review.affected == ()
    key_path = path.with_name(path.name.replace(".md", ".key.json"))
    content = path.read_text()
    assert path.stat().st_mode & 0o777 == 0o600 and key_path.stat().st_mode & 0o777 == 0o600
    assert "overlap 1000" not in content and "overlap 2000" not in content  # blinded
    assert "#### X" in content and "-loglevel error -nostats" in content
    variants = [(r.name, *compare.load(storage, r.name)) for r in (one, two)]
    base_result, base_text = compare.load(storage, base.name)
    cuts = compare.cuts_of(base_result)
    first_items = paired._items(storage, base_text, cuts, variants, 3)
    assert first_items == paired._items(storage, base_text, cuts, variants, 3)  # deterministic

    rated = content.replace("[ ] X", "[x] X", 1).replace("[ ] clean", "[x] clean", 1)
    rated = rated.replace("[ ] yes  [ ] no", "[x] yes  [x] no", 1)  # an invalid double tick
    path.write_text(rated)
    counts = paired.tally(storage, path.name)
    key = json.loads(key_path.read_text())["items"]
    first = key["P01"]["X"]
    assert counts["bestVersion"][first] == 1
    assert sum(counts["runs"][run]["Replay range"]["clean"] for run in counts["runs"]) == 1
    assert counts["invalidRows"] == 1
    assert SENTINEL not in json.dumps(counts, ensure_ascii=False)


def test_paired_review_marks_stored_pre_fix_decisions_anonymously(storage, audio):
    base, wide = run_overlaps(storage, audio, (0, 2000))
    result_path, transcript_path = wide / "result.json", wide / "transcript.json"
    result = json.loads(result_path.read_text())
    result["overlap"].pop("resolverVersion")  # as stored by the first Clip B runs
    result_path.write_text(json.dumps(result))
    transcript = json.loads(transcript_path.read_text())
    kept = transcript["segments"][1]
    kept["text"] = "。"  # a punctuation-only segment kept by the old rule
    transcript_path.write_text(json.dumps(transcript, ensure_ascii=False))
    item = {"kind": "conflict", "cut": 1, "startMs": kept["startMs"], "endMs": kept["endMs"]}
    (wide / "overlap.json").write_text(json.dumps({"reviewItems": [item]}))

    review = paired.create(storage, base.name, [wide.name], seed=3)
    assert review.pre_fix and len(review.affected) == 1
    assert re.fullmatch(r"P\d{2}", review.affected[0])
    content = review.path.read_text()
    assert "before the punctuation-only fix" in content
    assert content.count("· decided by the earlier rule") == 1  # only the affected item


def test_paired_review_paths_are_contained(storage, tmp_path):
    for bad in ("../x.md", "overlap-1.md", "overlap-20261004T000000Z.md/../../x"):
        with pytest.raises(StorageAccessError):
            paired.review_path(storage, bad)
    outside = tmp_path / "outside"
    outside.mkdir()
    (storage.root / "benchmarks").mkdir()
    (storage.root / "benchmarks" / "reviews").symlink_to(outside)
    with pytest.raises(StorageAccessError, match="symlink"):
        paired.review_path(storage, "overlap-20261004T000000Z.md")


def test_run_ids_accept_only_the_overlap_suffix(storage):
    run_dir(storage, "20261004T000000Z-clip-b-150s-warm-o2000")
    for bad in ("20261004T000000Z-clip-b-150s-warm-o", "20261004T000000Z-clip-b-150s-warm-x1"):
        with pytest.raises(StorageAccessError):
            run_dir(storage, bad)


# --- CLI ------------------------------------------------------------------------------------


@pytest.fixture
def env(monkeypatch, data_dir):
    monkeypatch.setenv("PEBBLE_DATA_DIR", str(data_dir))
    return data_dir


@pytest.mark.parametrize(
    ("args", "message"),
    [
        (["--overlap-ms", "3000"], "between 0 and 2000"),
        (["--overlap-ms", "1000", "--overlap-ms", "1000"], "once"),
        (["--overlap-ms", "1000", "--mode", "cold"], "warm only"),
        (["--chunk", "20", "--overlap-ms", "0", "--overlap-ms", "1000"], "single --chunk"),
    ],
)
def test_overlap_options_are_validated(env, capsys, args, message):
    code = main(["bench", "run", "--synthetic", "--chunk", "default", *args, "--dry-run"])
    assert code == 2 and message in capsys.readouterr().out


def test_dry_run_lists_each_overlap_run(env, capsys):
    code = main(
        [
            "bench",
            "run",
            "--synthetic",
            "--chunk",
            "default",
            "--overlap-ms",
            "0",
            "--overlap-ms",
            "1000",
            "--overlap-ms",
            "2000",
            "--dry-run",
        ]
    )
    assert code == 0
    assert "chunk targets: default · overlap: 0 ms, 1000 ms, 2000 ms" in capsys.readouterr().out


def test_compare_cli_is_offline_and_imports_no_models(env, audio):
    storage = Storage(env)
    storage.ensure()
    base, wide = run_overlaps(storage, audio, (0, 2000))
    code = (
        "import sys; from pebble_worker.cli import main; from pebble_worker.bench import network;"
        f"status = main(['bench', 'compare', '--baseline', {base.name!r}, '--run', {wide.name!r}]);"
        "heavy = ('funasr', 'torch', 'modelscope', 'transformers');"
        "print('heavy', sorted(m for m in heavy if m in sys.modules), 'net', network.attempts());"
        "sys.exit(status)"
    )
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert done.returncode == 0, done.stdout + done.stderr
    assert "heavy [] net 0" in done.stdout and "nothing was transcribed" in done.stdout
    assert SENTINEL not in done.stdout and base.name not in done.stdout
