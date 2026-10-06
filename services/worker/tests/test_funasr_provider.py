"""
FunASR provider with a fake AutoModel: no FunASR, torch or model weights needed.

All sentences below are invented filler text, not output from any real recording.
"""

from __future__ import annotations

import hashlib
import logging
import math
import wave

import pytest

from pebble_worker.errors import Cancelled, FailureCode, PipelineError
from pebble_worker.models.manifest import ModelFile, ModelSpec
from pebble_worker.models.verify import model_dir
from pebble_worker.pipeline.merge import ChunkResult, merge
from pebble_worker.pipeline.review import ReviewConfig, review_flags
from pebble_worker.providers.base import AudioChunk, RawSegment
from pebble_worker.providers.funasr import (
    AlignmentIssue,
    FunASRProvider,
    NormalizationError,
    TextConsistency,
    alignment_issue,
    chunk_alignment,
    comparable_text,
    compare_texts,
    describe_output,
    normalize_output,
    read_chunk,
    text_consistency,
    timestamps_align,
)
from pebble_worker.storage import Storage

CHUNK_MS = 30_000


def sentence(start, end, text, timestamp=None):
    item = {"text": text, "start": start, "end": end}
    if timestamp is not None:
        item["timestamp"] = timestamp
    return item


def per_char(start, end, count):
    step = (end - start) // count
    return [[start + i * step, start + (i + 1) * step] for i in range(count)]


def output(*sentences, text=None):
    joined = "".join(s["text"] for s in sentences) if text is None else text
    return [{"key": "chunk", "text": joined, "timestamp": [], "sentence_info": list(sentences)}]


NORMAL = output(
    sentence(600, 1900, "今天天气很好，", per_char(600, 1900, 6)),
    sentence(2100, 4000, "我们去公园散步。", per_char(2100, 4000, 7)),
)


# --- normalization: sentence_info is the only source of boundaries ------------------------------


def test_normal_output_maps_sentences_to_segments():
    segments = normalize_output(NORMAL, CHUNK_MS)
    assert segments == [
        RawSegment(600, 1900, "今天天气很好，"),
        RawSegment(2100, 4000, "我们去公园散步。"),
    ]
    assert all(s.confidence is None and s.speaker is None for s in segments)


@pytest.mark.parametrize(
    ("bad", "message"),
    [
        ({"text": "缺少结束", "start": 100}, "no valid end time"),
        ({"text": "缺少开始", "end": 900}, "no valid start time"),
        ({"text": "空的时间", "start": None, "end": 900}, "no valid start time"),
        ({"text": "负数", "start": -5, "end": 900}, "no valid start time"),
        ({"text": "不是数字", "start": "100", "end": 900}, "no valid start time"),
        ({"text": "布尔值", "start": True, "end": 900}, "no valid start time"),
        ({"text": "非数", "start": 100, "end": math.nan}, "no valid end time"),
        ({"text": "", "start": 100, "end": 900}, "has no text"),
        ({"text": "   ", "start": 100, "end": 900}, "has no text"),
        ({"start": 100, "end": 900}, "has no text"),
        ({"text": "倒过来", "start": 900, "end": 100}, "ends before it starts"),
        ({"text": "零长度", "start": 900, "end": 900}, "ends before it starts"),
        ({"text": "超出范围", "start": 100, "end": CHUNK_MS + 501}, "outside the section"),
        ({"text": "开始太晚", "start": CHUNK_MS, "end": CHUNK_MS + 100}, "outside the section"),
    ],
)
def test_invalid_sentences_fail_instead_of_being_guessed(bad, message):
    with pytest.raises(NormalizationError, match=message):
        normalize_output(output(sentence(10, 90, "开头"), bad, text="有文字"), CHUNK_MS)


def test_end_within_the_bound_tolerance_is_kept_as_reported():
    [segment] = normalize_output(output(sentence(29_000, CHUNK_MS + 400, "结尾")), CHUNK_MS)
    assert segment.end_ms == CHUNK_MS + 400  # merge clips to the audio duration


def test_out_of_order_sentences_fail():
    with pytest.raises(NormalizationError, match="starts before the previous"):
        normalize_output(output(sentence(2000, 3000, "第二"), sentence(500, 1500, "第一")), 9000)


def test_overlap_beyond_tolerance_fails_but_small_overlap_is_kept():
    with pytest.raises(NormalizationError, match="overlaps the previous"):
        normalize_output(output(sentence(0, 2000, "前面"), sentence(1800, 3000, "后面")), 9000)
    segments = normalize_output(
        output(sentence(0, 2000, "前面"), sentence(1950, 3000, "后面")), 9000
    )
    assert [(s.start_ms, s.end_ms) for s in segments] == [(0, 2000), (1950, 3000)]


def test_touching_sentences_are_valid():
    segments = normalize_output(
        output(sentence(0, 2000, "前面"), sentence(2000, 3000, "后面")), 9000
    )
    assert len(segments) == 2


def test_float_times_are_rounded_to_milliseconds():
    [segment] = normalize_output(output(sentence(100.4, 899.6, "小数")), 9000)
    assert (segment.start_ms, segment.end_ms) == (100, 900)


# --- character timestamps: only a consistency check ---------------------------------------------


def test_character_timestamp_count_mismatch_is_flagged_not_repaired():
    # 7 characters but 6 timestamps, then 3 characters but 4 (a boundary one character off).
    shifted = output(
        sentence(1000, 2300, "我们明天再见面明。", per_char(1000, 2300, 6)),
        sentence(4000, 4700, "天见吧。", per_char(4000, 4700, 4)),
    )
    segments = normalize_output(shifted, CHUNK_MS)
    assert [s.review_flags for s in segments] == [
        ("timestamp_alignment_anomaly",),
        ("timestamp_alignment_anomaly",),
    ]
    assert [(s.start_ms, s.end_ms, s.text) for s in segments] == [
        (1000, 2300, "我们明天再见面明。"),
        (4000, 4700, "天见吧。"),
    ]


def test_timestamps_outside_the_sentence_are_flagged():
    bad = output(sentence(1000, 2000, "两个", [[900, 1500], [1500, 2000]]))
    assert normalize_output(bad, CHUNK_MS)[0].review_flags == ("timestamp_alignment_anomaly",)


def test_missing_character_timestamps_are_not_an_anomaly():
    assert normalize_output(output(sentence(0, 900, "没有")), CHUNK_MS)[0].review_flags == ()


@pytest.mark.parametrize(
    ("text", "count", "aligned"),
    [
        ("你好，世界。", 4, True),
        ("我用 iPhone 15 拍照", 6, True),  # 4 characters + 2 Latin/digit runs
        ("我用 iPhone 拍照", 4, False),
        ("。", 0, True),
    ],
)
def test_token_counting_for_alignment(text, count, aligned):
    stamps = per_char(0, 1200, count) if count else []
    assert timestamps_align(text, stamps, 0, 1200) is aligned


def test_malformed_timestamp_pairs_are_flagged():
    assert not timestamps_align("两个", [[0, 100], [100]], 0, 500)
    assert not timestamps_align("两个", [[0, 100], [300, 200]], 0, 500)
    assert not timestamps_align("两个", "not a list", 0, 500)


@pytest.mark.parametrize(
    ("text", "stamps", "issue"),
    [
        ("两个字", per_char(0, 900, 4), AlignmentIssue("count_difference", 1)),
        ("两个字", per_char(0, 900, 1), AlignmentIssue("count_difference", -2)),
        ("两个", [[0, 100], [300, 200]], AlignmentIssue("timestamps_out_of_order")),
        ("两个", [[300, 400], [100, 200]], AlignmentIssue("timestamps_out_of_order")),
        ("两个", [[0, 100], [100, 600]], AlignmentIssue("timestamp_outside_segment_range")),
        ("两个", [[0, 100], [100]], AlignmentIssue("malformed_timestamps")),
        ("两个", "not a list", AlignmentIssue("malformed_timestamps")),
        ("两个", [[0, 100], [100, 200]], None),
        ("两个", None, None),
    ],
)
def test_alignment_issues_carry_a_reason_and_numbers_only(text, stamps, issue):
    assert alignment_issue(text, stamps, 0, 500) == issue


def test_chunk_alignment_compares_totals_and_never_keeps_text():
    result = output(
        sentence(0, 900, "你好，", per_char(0, 900, 3)),  # one timestamp too many
        sentence(1000, 2000, "世界。", per_char(1000, 2000, 2)),
    )
    result[0]["timestamp"] = per_char(0, 2000, 5)
    alignment = chunk_alignment(result)
    assert alignment is not None
    assert (alignment.text_tokens, alignment.timestamps) == (4, 5)
    assert alignment.issues == (AlignmentIssue("count_difference", 1), None)
    assert "你" not in repr(alignment) and "世" not in repr(alignment)
    assert chunk_alignment([{"key": "c", "text": "", "timestamp": []}]) is None


def test_provider_keeps_the_last_chunks_alignment_without_changing_segments(storage):
    install_models(storage)
    provider, _ = make_provider(storage)
    assert provider.last_alignment is None
    segments = provider.transcribe(CHUNK, NEVER)
    assert segments == normalize_output(NORMAL, CHUNK_MS)
    assert provider.last_alignment is not None
    assert provider.last_alignment.issues == (None, None)


# --- empty output ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "silent",
    [
        [],
        [{"key": "chunk", "text": "", "timestamp": []}],
        [{"key": "chunk", "text": "  ", "timestamp": [], "sentence_info": []}],
    ],
)
def test_no_speech_in_a_chunk_gives_no_segments(silent):
    assert normalize_output(silent, CHUNK_MS) == []


def test_text_without_sentence_timing_fails():
    with pytest.raises(NormalizationError, match="without sentence timing"):
        normalize_output([{"key": "chunk", "text": "有字没有时间", "timestamp": []}], CHUNK_MS)


@pytest.mark.parametrize(
    "shape", [{"text": "x"}, [1], [{"text": ""}, {"text": ""}], [{"sentence_info": "x"}]]
)
def test_unexpected_result_shapes_fail(shape):
    with pytest.raises(NormalizationError):
        normalize_output(shape, CHUNK_MS)


def test_output_description_never_contains_text():
    shape = describe_output(NORMAL)
    assert "今天" not in str(shape) and "公园" not in str(shape)
    assert shape.sentences == 2
    assert shape.sentence_keys == ("end", "start", "text", "timestamp")
    assert shape.text_chars == len("今天天气很好，我们去公园散步。")


# --- review flags ---------------------------------------------------------------------------------


def test_review_flags_thresholds():
    config = ReviewConfig()
    spans = [
        (2100, 3000, ()),  # gap 2100 > 2000 from the start of audio
        (3000, 10_001, ()),  # 7001 ms long
        (10_100, 10_899, ("timestamp_alignment_anomaly",)),  # 799 ms
        (12_900, 13_700, ()),  # gap 2001; exactly 800 ms is not short
        (15_700, 22_700, ()),  # gap exactly 2000 and exactly 7000 ms: neither flag
    ]
    assert review_flags(spans, config) == [
        ["speech_gap"],
        ["long_segment"],
        ["short_fragment", "timestamp_alignment_anomaly"],
        ["speech_gap"],
        [],
    ]


def test_review_thresholds_are_configurable():
    assert review_flags([(0, 3000, ())], ReviewConfig(long_segment_ms=2000)) == [["long_segment"]]
    assert review_flags([(500, 900, ())], ReviewConfig(speech_gap_ms=400)) == [
        ["short_fragment", "speech_gap"]
    ]


# --- whole text versus sentence text (diagnostic only) -------------------------------------------


@pytest.mark.parametrize(
    ("text", "comparable"),
    [
        ("今天 天气\t很好\n", "今天天气很好"),  # whitespace
        ("今天，天气很好。“对\uff01”", "今天天气很好对"),  # Chinese punctuation
        ("Hello, world... (ok) - yes?", "helloworldokyes"),  # Latin punctuation and case
        ("\uff21\uff22\uff23\uff11\uff12\uff13\u3000测试", "abc123测试"),  # NFKC width, then case
        ("1+1=2，涨了5%，¥30", "1+1=2涨了5%¥30"),  # symbols and % are content
        ("A&B，#1号，50/50，@某人", "a&b#1号50/50@某人"),  # punctuation that is kept
        ("第1，第2。3、4", "第1第23、4"),  # sentence commas go; one between digits stays
        ("温度3.5度，降了-5度\uff1b12:30见", "温度3.5度降了-5度12:30见"),
        ("一共1,000元，或1.000元", "一共1,000元或1.000元"),
        ("\uff11\uff12\uff1a\uff13\uff10", "12:30"),  # full-width digits and colon after NFKC
        ("1 000", "1000"),  # whitespace is ignored, even between digits
        ("用 GPT 写 email", "用gpt写email"),
    ],
)
def test_comparable_text_ignores_only_the_documented_differences(text, comparable):
    assert comparable_text(text) == comparable


@pytest.mark.parametrize(
    ("whole", "sentence"),
    [
        ("3.5", "35"),
        ("1,000", "1000"),
        ("1.000", "1000"),
        ("1.000", "1,000"),  # no locale-specific equivalence
        ("12:30", "1230"),
        ("-5", "5"),
        ("1/2", "12"),
        ("5%", "5"),
    ],
)
def test_numeric_punctuation_is_never_ignored(whole, sentence):
    for a, b in ((whole, sentence), (sentence, whole)):
        assert compare_texts(f"温度{a}度。", [f"温度{b}度。"]).category != "consistent"


def test_sentence_punctuation_around_numbers_is_still_ignored():
    assert compare_texts("我买了3个，花了5元。", ["我买了3个", "花了5元"]).category == "consistent"
    assert compare_texts("第1，第2。", ["第1第2"]).category == "consistent"
    # A sentence split inside a number keeps its punctuation on one side or the other.
    assert compare_texts("温度3.5度。", ["温度3.", "5度。"]).category == "consistent"


def test_comparable_text_only_folds_latin_case():
    assert comparable_text("ÉΣ") == "ÉΣ"  # accented Latin and other scripts are left alone


@pytest.mark.parametrize(
    ("whole", "sentences", "expected"),
    [
        ("今天天气很好，我们去公园。", ["今天天气很好，", "我们去公园。"], ("consistent", None)),
        ("今天 天气很好。我们去公园", ["今天天气很好，", "我们去公园。"], ("consistent", None)),
        # A sentence the whole text has but the sentence list doesn't.
        (
            "今天天气很好，我们去公园。",
            ["今天天气很好，"],
            ("whole_text_has_unmatched_content", 6),
        ),
        ("今天天气很好，我们去公园。", ["我们去公园。"], ("whole_text_has_unmatched_content", 0)),
        # The sentences have something the whole text doesn't.
        (
            "我们去公园。",
            ["我们去公园。", "然后回家。"],
            ("sentence_text_has_unmatched_content", 5),
        ),
        # Same length, different content: counts alone would not notice.
        ("今天天气很好。", ["今天天气不好。"], ("content_differs", 4)),
        # Same characters, different order.
        ("我们去公园。今天天气很好。", ["今天天气很好。", "我们去公园。"], ("content_differs", 0)),
        # English words and digits are content.
        ("我用email发了3次", ["我用发了3次"], ("whole_text_has_unmatched_content", 2)),
        ("一共是30块", ["一共是31块"], ("content_differs", 4)),
        ("1+1=2", ["11=2"], ("whole_text_has_unmatched_content", 1)),
        ("涨了5%", ["涨了5"], ("whole_text_has_unmatched_content", 3)),
    ],
)
def test_compare_texts_in_order(whole, sentences, expected):
    result = compare_texts(whole, sentences)
    assert (result.category, result.first_mismatch) == expected
    assert result.whole_length == len(comparable_text(whole))
    assert result.sentence_length == len(comparable_text("".join(sentences)))


def test_text_consistency_reads_provider_output_and_never_keeps_text():
    result = text_consistency(output(sentence(0, 900, "你好，"), text="你好，世界。"))
    assert result == TextConsistency("whole_text_has_unmatched_content", 4, 2, 2)
    assert "你" not in str(result) and "你" not in repr(result)
    assert text_consistency(NORMAL) == TextConsistency("consistent", 13, 13, None)
    assert text_consistency([]) is None
    assert text_consistency([{"key": "c", "text": "", "timestamp": []}]) is None


def test_inconsistent_text_is_logged_as_numbers_and_never_changes_segments(storage, caplog):
    install_models(storage)
    mismatched = output(
        sentence(600, 1900, "今天天气很好，", per_char(600, 1900, 6)),
        text="今天天气很好，我们去公园散步。",
    )
    provider, _ = make_provider(storage, FakeAutoModel(mismatched))
    with caplog.at_level(logging.INFO, logger="pebble.funasr"):
        segments = provider.transcribe(CHUNK, NEVER)
    assert segments == [RawSegment(600, 1900, "今天天气很好，")]  # nothing added or repaired
    messages = [r.getMessage() for r in caplog.records]
    assert any(
        "text_consistency=whole_text_has_unmatched_content whole_length=13 sentence_length=6 "
        "first_mismatch=6" in m
        for m in messages
    )
    assert not any(ch in m for m in messages for ch in "今天我们公园")  # no text in the log


def test_consistency_is_per_chunk_with_no_stale_result(storage, caplog):
    install_models(storage)
    model = FakeAutoModel(NORMAL)
    provider, _ = make_provider(storage, model)
    with caplog.at_level(logging.INFO, logger="pebble.funasr"):
        provider.transcribe(CHUNK, NEVER)
        first = [r.getMessage() for r in caplog.records if "text_consistency" in r.getMessage()]
        caplog.clear()
        model.result = [{"key": "chunk", "text": "", "timestamp": []}]  # no speech
        assert provider.transcribe(CHUNK, NEVER) == []
        model.error = RuntimeError("boom")
        with pytest.raises(PipelineError):
            provider.transcribe(CHUNK, NEVER)
        later = [r.getMessage() for r in caplog.records if "text_consistency" in r.getMessage()]
    assert first == [
        "chunk 0: text_consistency=consistent whole_length=13 sentence_length=13 "
        "first_mismatch=None"
    ]
    assert later == []  # an empty chunk or a failure reports nothing, not the previous result
    assert not hasattr(provider, "last_consistency")


# --- provider (fake models, fake AutoModel) -------------------------------------------------------


def _spec(role, contents):
    files = tuple(
        ModelFile(name, len(data), hashlib.sha256(data).hexdigest())
        for name, data in contents.items()
    )
    return ModelSpec(
        role=role,
        model_id=f"test/{role}",
        revision="v0.0.1",
        license="Apache-2.0",
        license_source="test",
        attribution=f"{role} (test fixture)",
        files=files,
        total_size=sum(f.size for f in files),
    )


CONTENTS = {"configuration.json": b"{}", "model.pt": b"weights"}
SPECS = {role: _spec(role, CONTENTS) for role in ("asr", "vad", "punctuation")}
RUNTIME = {"funasr": "1.4.16", "torch": "2.11.0", "torchaudio": "2.11.0", "modelscope": "1.40.1"}


class FakeAutoModel:
    def __init__(self, result=NORMAL, error=None):
        self.result = result
        self.error = error
        self.calls = []

    def generate(self, *, input, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.result


@pytest.fixture
def storage(tmp_path):
    storage = Storage(tmp_path / "pebble")
    storage.ensure()
    return storage


def install_models(storage, contents=CONTENTS):
    for spec in SPECS.values():
        directory = model_dir(storage, spec)
        directory.mkdir(parents=True, exist_ok=True)
        for name, data in contents.items():
            (directory / name).write_bytes(data)


def make_provider(storage, model=None, *, runtime=RUNTIME, loader=None):
    loads = []

    def fake_loader(paths):
        loads.append(dict(paths))
        return model or FakeAutoModel()

    provider = FunASRProvider(
        storage,
        loader=loader or fake_loader,
        runtime=lambda: runtime,
        reader=lambda chunk: [0.0] * 16,
        models=SPECS,
    )
    return provider, loads


CHUNK = AudioChunk(0, 0, CHUNK_MS, path=None)  # type: ignore[arg-type]
NEVER = lambda: False  # noqa: E731


def test_health_reports_a_missing_environment(storage):
    provider, _ = make_provider(storage, runtime=None)
    health = provider.health()
    assert (health.available, health.state) == (False, "environment_missing")
    assert "npm run pebble:setup" in health.detail
    assert health.hint is not None and "npm run pebble:setup" in health.hint


def test_health_reports_missing_models(storage):
    provider, _ = make_provider(storage)
    health = provider.health()
    assert (health.available, health.state) == (False, "models_missing")
    assert "6 of 6" in health.detail and "pebble:setup" in health.detail
    assert health.hint is not None and health.hint.endswith("npm run pebble:setup")


def test_health_reports_wrong_sizes_without_hashing(storage):
    install_models(storage, {**CONTENTS, "model.pt": b"weights!"})
    health = make_provider(storage)[0].health()
    assert (health.available, health.state) == (False, "verification_failed")
    assert health.hint is not None and "Download them again" in health.hint


@pytest.mark.parametrize(
    "state", ["environment_missing", "models_missing", "verification_failed", "load_failed"]
)
def test_hints_are_plain_language_with_at_most_one_command(state):
    from pebble_worker.providers.funasr import HINTS

    hint = HINTS[state]
    assert hint.count("npm run") + hint.count("uv ") <= 1
    for jargon in ("UV_CACHE_DIR", "services/worker", "SHA", "FunASR", "manifest", "~/.pebble"):
        assert jargon not in hint


def test_health_is_checking_until_background_verification_passes(storage):
    install_models(storage)
    provider, loads = make_provider(storage)
    health = provider.health()
    assert (health.available, health.state, health.hint) == (False, "checking", None)
    provider.prepare(wait=True)
    health = provider.health()
    assert (health.available, health.state, health.hint) == (True, "ready", None)
    assert "first transcription" in health.detail
    assert loads == []  # verification never loads models


def test_health_never_blocks_on_verification(storage, monkeypatch):
    import threading

    from pebble_worker.providers import funasr

    install_models(storage)
    release = threading.Event()
    real_verify = funasr.verify_model

    def slow_verify(storage_, spec):
        release.wait(5)
        return real_verify(storage_, spec)

    monkeypatch.setattr(funasr, "verify_model", slow_verify)
    provider, _ = make_provider(storage)
    provider.prepare()  # as the worker does at startup
    for _ in range(3):
        assert provider.health().state == "checking"  # returns while hashing is blocked
    release.set()
    provider.prepare(wait=True)
    assert provider.health().state == "ready"


def test_hash_mismatch_is_reported_by_background_verification(storage):
    install_models(storage, {**CONTENTS, "model.pt": b"WEIGHTS"})  # same size, wrong content
    provider, loads = make_provider(storage)
    provider.prepare(wait=True)
    health = provider.health()
    assert (health.available, health.state) == (False, "verification_failed")
    assert health.hint is not None and "npm run pebble:setup" in health.hint
    assert loads == []


def test_changed_files_are_verified_again(storage):
    import os

    install_models(storage)
    provider, _ = make_provider(storage)
    provider.prepare(wait=True)
    assert provider.health().state == "ready"
    target = model_dir(storage, SPECS["asr"]) / "model.pt"
    target.write_bytes(b"WEIGHTS")  # same size, different content
    os.utime(target, ns=(1, 1))
    assert provider.health().state == "checking"
    provider.prepare(wait=True)
    assert provider.health().state == "verification_failed"
    target.write_bytes(CONTENTS["model.pt"])  # repaired, e.g. by models pull
    assert provider.health().state == "checking"
    provider.prepare(wait=True)
    assert provider.health().state == "ready"


def test_first_job_reuses_background_verification(storage, monkeypatch):
    from pebble_worker.providers import funasr

    install_models(storage)
    provider, loads = make_provider(storage)
    provider.prepare(wait=True)
    calls = []
    monkeypatch.setattr(funasr, "verify_model", lambda *a: calls.append(a))
    provider.transcribe(CHUNK, NEVER)
    assert calls == [] and len(loads) == 1


def test_models_load_lazily_once_from_local_folders(storage):
    install_models(storage)
    model = FakeAutoModel()
    provider, loads = make_provider(storage, model)
    provider.transcribe(CHUNK, NEVER)
    provider.transcribe(CHUNK, NEVER)
    assert len(loads) == 1
    assert loads[0] == {role: model_dir(storage, spec) for role, spec in SPECS.items()}
    assert model.calls == [{"sentence_timestamp": True}] * 2
    assert provider.health().detail == "FunASR Paraformer is loaded (CPU)."


def test_hash_mismatch_refuses_to_load(storage):
    install_models(storage, {**CONTENTS, "model.pt": b"WEIGHTS"})  # same size, wrong content
    provider, loads = make_provider(storage)
    with pytest.raises(PipelineError) as raised:
        provider.transcribe(CHUNK, NEVER)
    assert raised.value.code == FailureCode.PROVIDER_UNAVAILABLE
    assert "failed verification" in raised.value.message
    assert loads == []
    assert provider.health().state == "verification_failed"


def test_files_changed_after_verification_are_checked_before_loading(storage):
    import os

    install_models(storage)
    provider, loads = make_provider(storage)
    provider.prepare(wait=True)
    target = model_dir(storage, SPECS["vad"]) / "model.pt"
    target.write_bytes(b"WEIGHTS")
    os.utime(target, ns=(1, 1))
    with pytest.raises(PipelineError) as raised:
        provider.transcribe(CHUNK, NEVER)
    assert raised.value.code == FailureCode.PROVIDER_UNAVAILABLE
    assert loads == []


def test_missing_environment_fails_the_job_without_fallback(storage):
    install_models(storage)
    provider, loads = make_provider(storage, runtime=None)
    with pytest.raises(PipelineError) as raised:
        provider.transcribe(CHUNK, NEVER)
    assert raised.value.code == FailureCode.PROVIDER_UNAVAILABLE
    assert "npm run pebble:setup" in (raised.value.hint or "")
    assert loads == []


def test_load_failure_is_reported_and_retried_on_the_next_job(storage):
    install_models(storage)
    attempts = []

    def broken_loader(paths):
        attempts.append(paths)
        raise RuntimeError("cannot load")

    provider, _ = make_provider(storage, loader=broken_loader)
    for _ in range(2):
        with pytest.raises(PipelineError) as raised:
            provider.transcribe(CHUNK, NEVER)
        assert raised.value.code == FailureCode.PROVIDER_UNAVAILABLE
    assert len(attempts) == 2
    health = provider.health()
    assert (health.available, health.state) == (False, "load_failed")
    assert "RuntimeError" in health.detail
    assert health.hint is not None and "RuntimeError" not in health.hint


def test_execution_failure_is_a_retryable_provider_error(storage):
    install_models(storage)
    provider, _ = make_provider(storage, FakeAutoModel(error=RuntimeError("boom")))
    with pytest.raises(PipelineError) as raised:
        provider.transcribe(CHUNK, NEVER)
    assert raised.value.code == FailureCode.PROVIDER_ERROR and raised.value.retryable


def test_normalization_failure_is_a_clear_non_retryable_error(storage):
    install_models(storage)
    bad = output(sentence(100, None, "没有结束"))
    provider, _ = make_provider(storage, FakeAutoModel(bad))
    with pytest.raises(PipelineError) as raised:
        provider.transcribe(CHUNK, NEVER)
    error = raised.value
    assert error.code == FailureCode.PROVIDER_ERROR and error.retryable is False
    assert "sentence 1 has no valid end time" in error.message
    assert "没有结束" not in error.message  # recognized text never appears in errors


def test_cancel_is_checked_before_loading(storage):
    install_models(storage)
    provider, loads = make_provider(storage)
    with pytest.raises(Cancelled):
        provider.transcribe(CHUNK, lambda: True)
    assert loads == []


def test_provenance_details_name_every_model_and_runtime(storage):
    details = make_provider(storage)[0].provenance_details()
    assert [(m.role, m.id, m.revision) for m in details.models] == [
        ("asr", "test/asr", "v0.0.1"),
        ("vad", "test/vad", "v0.0.1"),
        ("punctuation", "test/punctuation", "v0.0.1"),
    ]
    assert details.runtime == {**RUNTIME, "device": "cpu"}


def test_real_manifest_is_the_default(storage):
    provider = FunASRProvider(storage, runtime=lambda: RUNTIME)
    assert [m.id for m in provider.provenance_details().models] == [
        "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
        "iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
    ]
    assert provider.kind == "asr" and provider.model.startswith("iic/speech_seaco_paraformer")


# --- chunk reading --------------------------------------------------------------------------------


def _wav(path, *, rate=16000, channels=1, width=2, frames=1600):
    with wave.open(str(path), "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(width)
        out.setframerate(rate)
        out.writeframes(b"\x00\x40" * frames * channels)
    return AudioChunk(0, 0, 100, path)


@pytest.mark.parametrize(
    "params", [{"rate": 44100}, {"channels": 2}, {"width": 1}], ids=["44k", "stereo", "8bit"]
)
def test_chunks_that_are_not_16k_mono_pcm_are_unsupported_media(tmp_path, params):
    with pytest.raises(PipelineError) as raised:
        read_chunk(_wav(tmp_path / "chunk.wav", **params))
    assert raised.value.code == FailureCode.UNSUPPORTED_MEDIA


def test_unreadable_chunk_is_unsupported_media(tmp_path):
    (tmp_path / "chunk.wav").write_bytes(b"not a wav")
    with pytest.raises(PipelineError) as raised:
        read_chunk(AudioChunk(0, 0, 100, tmp_path / "chunk.wav"))
    assert raised.value.code == FailureCode.UNSUPPORTED_MEDIA


def test_valid_chunk_reads_as_float_samples(tmp_path):
    pytest.importorskip("numpy")
    audio = read_chunk(_wav(tmp_path / "chunk.wav"))
    assert audio.dtype.name == "float32" and len(audio) == 1600
    assert float(audio[0]) == 0.5


# --- through merge --------------------------------------------------------------------------------


def test_merge_offsets_chunks_and_keeps_flags_and_provenance(storage):
    provider, _ = make_provider(storage)
    first = normalize_output(NORMAL, CHUNK_MS)
    second = normalize_output(
        output(sentence(200, 7600, "这是一句很长很长的句子。", per_char(200, 7600, 3))), CHUNK_MS
    )
    transcript = merge(
        episode_id="ep-0123456789ab",
        duration_ms=45_000,
        language="zh-CN",
        chunks=[ChunkResult(0, first, index=0), ChunkResult(CHUNK_MS, second, index=1)],
        provider=provider,
    )
    payload = transcript.dump()
    segments = payload["segments"]
    assert [(s["startMs"], s["endMs"], s["chunkIndex"]) for s in segments] == [
        (600, 1900, 0),
        (2100, 4000, 0),
        (30_200, 37_600, 1),
    ]
    assert [s["review"]["flags"] for s in segments] == [
        [],
        [],
        ["long_segment", "timestamp_alignment_anomaly", "speech_gap"],
    ]
    assert all(s["confidence"] is None and s["tokens"] is None for s in segments)
    provenance = payload["provenance"]
    assert provenance["kind"] == "asr" and provenance["provider"] == "funasr"
    assert provenance["notes"] == "Transcribed on this computer with FunASR Paraformer"
    assert [m["role"] for m in provenance["models"]] == ["asr", "vad", "punctuation"]
    assert provenance["runtime"]["device"] == "cpu"
    assert provenance["review"] == {
        "thresholds": {"longSegmentMs": 7000, "shortFragmentMs": 800, "speechGapMs": 2000}
    }
