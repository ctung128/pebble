"""
FunASR provider with a fake AutoModel: no FunASR, torch or model weights needed.

All sentences below are invented filler text, not output from any real recording.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
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
    UnitMappingError,
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


def spans(start, end, count):
    """`count` touching pairs that exactly cover start..end (the last pair ends at `end`)."""
    return [
        [start + (end - start) * i // count, start + (end - start) * (i + 1) // count]
        for i in range(count)
    ]


per_char = spans

UNIT = re.compile(r"[㐀-鿿]|[A-Za-z0-9]+")


def sentence(start, end, text, timestamp=None):
    item = {"text": text, "start": start, "end": end}
    if timestamp is not None:
        item["timestamp"] = timestamp
    return item


def output(*sentences, text=None):
    """
    FunASR-1.4.16-shaped output where FunASR's own sentences were right: one unit per CJK
    character or Latin/digit run, each sentence's pairs (or even spans) as the unit timing.
    """
    units, pairs = [], []
    for s in sentences:
        found = UNIT.findall(s["text"])
        units += found
        pairs += s.get("timestamp") or spans(s["start"], s["end"], max(len(found), 1))[: len(found)]
    joined = "".join(s["text"] for s in sentences) if text is None else text
    return [
        {
            "key": "chunk",
            "text": joined,
            "timestamp": pairs,
            "raw_text": " ".join(units),
            "sentence_info": list(sentences),
        }
    ]


def one_sentence_output(key, text, start, end):
    """FunASR-shaped output for one invented sentence, its units spread evenly over start..end."""
    units = UNIT.findall(text)
    pairs = spans(start, end, len(units))
    sentence_info = [{"text": text, "start": start, "end": end, "timestamp": [*map(list, pairs)]}]
    item = {"key": key, "text": text, "timestamp": pairs, "raw_text": " ".join(units)}
    return [{**item, "sentence_info": sentence_info}]


def units_output(text, units, pairs, sentence_info=None):
    """Explicit FunASR-shaped output: punctuated text, whitespace-separated units, pairs."""
    item = {"key": "chunk", "text": text, "timestamp": pairs, "raw_text": " ".join(units)}
    if sentence_info is not None:
        item["sentence_info"] = sentence_info
    return [item]


def lines(result, duration=CHUNK_MS):
    return [(s.start_ms, s.end_ms, s.text) for s in normalize_output(result, duration)]


NORMAL = output(
    sentence(600, 1900, "今天天气很好，", per_char(600, 1900, 6)),
    sentence(2100, 4000, "我们去公园散步。", per_char(2100, 4000, 7)),
)


# --- normalization: lines from recognition units -------------------------------------------------


def test_normal_output_maps_sentences_to_segments():
    segments = normalize_output(NORMAL, CHUNK_MS)
    assert segments == [
        RawSegment(600, 1900, "今天天气很好，"),
        RawSegment(2100, 4000, "我们去公园散步。"),
    ]
    assert all(s.confidence is None and s.speaker is None for s in segments)


# FunASR 1.4.16 with VAD: two VAD segments "甲 乙 丙" and "丁 戊" (one pair each unit), joined
# with a space in raw_text but without one in the text it splits into sentences, so its
# sentence_info pairs four text units with five pairs and drifts one character per join.
TWO_VAD = units_output(
    "甲乙丙。丁戊。",
    ["甲", "乙", "丙", "丁", "戊"],
    [[0, 100], [100, 200], [200, 300], [1000, 1100], [1100, 1200]],
    sentence_info=[
        {
            "text": "甲乙丙丁。",
            "start": 0,
            "end": 300,
            "timestamp": [[0, 100], [100, 200], [200, 300]],
        },
        {"text": "戊。", "start": 1000, "end": 1200, "timestamp": [[1000, 1100], [1100, 1200]]},
    ],
)


def test_displaced_sentence_info_after_a_vad_join_is_not_used():
    assert lines(TWO_VAD) == [(0, 300, "甲乙丙。"), (1000, 1200, "丁戊。")]


def test_several_joins_stay_aligned_with_no_timed_punctuation_only_tail():
    # Four VAD segments of two units: FunASR's sentence text is three characters ahead by the
    # end, and its last sentence is only "。". Each line here keeps its own units' pairs.
    units = list("甲乙丙丁戊己庚辛")
    pairs = [[i * 100, i * 100 + 100] for i in range(8)]
    result = units_output("甲乙。丙丁。戊己。庚辛。", units, pairs)
    assert lines(result) == [
        (0, 200, "甲乙。"),
        (200, 400, "丙丁。"),
        (400, 600, "戊己。"),
        (600, 800, "庚辛。"),
    ]
    assert all(any("一" <= c <= "鿿" for c in text) for _, _, text in lines(result))


def test_latin_words_and_numbers_keep_their_single_unit_pairs():
    result = units_output(
        "我用 iPhone 15 拍照，很好。",
        ["我", "用", "iPhone", "15", "拍", "照", "很", "好"],
        [
            [0, 100],
            [100, 200],
            [200, 700],
            [700, 900],
            [900, 1000],
            [1000, 1100],
            [1300, 1400],
            [1400, 1500],
        ],
    )
    segments = normalize_output(result, CHUNK_MS)
    assert [(s.start_ms, s.end_ms, s.text) for s in segments] == [
        (0, 1100, "我用 iPhone 15 拍照，"),
        (1300, 1500, "很好。"),
    ]
    assert [s.review_flags for s in segments] == [(), ()]


@pytest.mark.parametrize(
    ("text", "units", "expected"),
    [
        # Inside a unit, punctuation is the unit's own text and never a boundary.
        ("涨了3.5个点。", ["涨", "了", "3.5", "个", "点"], ["涨了3.5个点。"]),
        ("U.S.的政策。", ["U.S.", "的", "政", "策"], ["U.S.的政策。"]),
        ("好。然后。", ["好。", "然", "后"], ["好。然后。"]),
        # ASCII , and . between units (decimals, Latin) are kept and never end a line.
        ("涨了3.5个点。", ["涨", "了", "3", "5", "个", "点"], ["涨了3.5个点。"]),
        ("hello, world. 好。", ["hello", "world", "好"], ["hello, world. 好。"]),
        # The marks FunASR itself ends sentences at (comma, full stop, question mark,
        # enumeration comma) and exclamation marks.
        ("苹果、香蕉，都好。", list("苹果香蕉都好"), ["苹果、", "香蕉，", "都好。"]),
        ("真的\uff1f\uff01好。", list("真的好"), ["真的\uff1f\uff01", "好。"]),
        # Quoted speech: the colon and opening quote don't split; a closing quote stays with
        # the line it closes; an opening quote after a full stop starts the next line.
        (
            "他说\uff1a“你好。”然后走了。",
            list("他说你好然后走了"),
            ["他说\uff1a“你好。”", "然后走了。"],
        ),
        ("走了。“好”。", list("走了好"), ["走了。", "“好”。"]),
        # Semicolons don't split; content after the last mark is kept as a final line.
        ("一\uff1b二。三", list("一二三"), ["一\uff1b二。", "三"]),
    ],
)
def test_line_boundary_policy(text, units, expected):
    pairs = [[i * 100, i * 100 + 100] for i in range(len(units))]
    assert [t for _, _, t in lines(units_output(text, units, pairs))] == expected


def test_a_line_is_timed_by_its_first_and_last_units_only():
    units = list("一二三四")
    pairs = [[100, 250], [260, 400], [900, 1000], [1000, 1180]]
    assert lines(units_output("一二，三四。", units, pairs)) == [
        (100, 400, "一二，"),
        (900, 1180, "三四。"),
    ]


def test_all_recognized_content_is_kept_in_order():
    text = "价格涨了5%，约¥30。A&B 的 50/50 计划\uff01"
    units = ["价", "格", "涨", "了", "5%", "约", "¥30", "A&B", "的", "50/50", "计", "划"]
    pairs = [[i * 100, i * 100 + 100] for i in range(len(units))]
    joined = "".join(t for _, _, t in lines(units_output(text, units, pairs)))
    assert comparable_text(joined) == comparable_text(text)
    assert joined.replace(" ", "") == text.replace(" ", "")


@pytest.mark.parametrize(
    ("result", "message"),
    [
        (
            units_output("甲乙丙。", ["甲", "乙", "丙"], [[0, 1], [1, 2]]),
            "3 units but 2 timestamp pairs",
        ),
        (
            units_output("甲乙丙丁。", ["甲", "乙", "丙"], [[0, 1], [1, 2], [2, 3]]),
            "content after its 3 units",
        ),
        (units_output("甲丙。", ["甲", "乙"], [[0, 1], [1, 2]]), "unit 2 of 2 doesn't match"),
        (units_output("甲乙x丙。", ["甲", "乙", "丙"], [[0, 1], [1, 2], [2, 3]]), "unit 3 of 3"),
        ([{"key": "c", "text": "甲乙。", "timestamp": [[0, 1], [1, 2]]}], "no unit text"),
        ([{"key": "c", "text": "", "timestamp": [[0, 1]], "raw_text": "甲"}], "unit 1 of 1"),
    ],
)
def test_mappings_that_are_not_exact_fail_instead_of_being_guessed(result, message):
    with pytest.raises(UnitMappingError, match=message) as raised:
        normalize_output(result, CHUNK_MS)
    assert not any(c in str(raised.value) for c in "甲乙丙丁")  # counts only, never text


@pytest.mark.parametrize(
    ("pair", "message"),
    [
        ([100], "unit 2 has a malformed timestamp pair"),
        ("100,200", "unit 2 has a malformed timestamp pair"),
        ([100, None], "unit 2 has no valid time"),
        ([-5, 200], "unit 2 has no valid time"),
        (["100", 200], "unit 2 has no valid time"),
        ([True, 200], "unit 2 has no valid time"),
        ([100, math.nan], "unit 2 has no valid time"),
    ],
)
def test_invalid_unit_timing_fails_instead_of_being_guessed(pair, message):
    with pytest.raises(NormalizationError, match=message):
        normalize_output(units_output("甲乙。", ["甲", "乙"], [[0, 50], pair]), CHUNK_MS)


@pytest.mark.parametrize(
    ("pairs", "message"),
    [
        ([[900, 900]], "ends before it starts"),
        ([[900, 100]], "ends before it starts"),
        ([[100, CHUNK_MS + 501]], "outside the section"),
        ([[CHUNK_MS, CHUNK_MS + 100]], "outside the section"),
    ],
)
def test_invalid_lines_fail(pairs, message):
    with pytest.raises(NormalizationError, match=message):
        normalize_output(units_output("甲。", ["甲"], pairs), CHUNK_MS)


def test_end_within_the_bound_tolerance_is_kept_as_reported():
    [segment] = normalize_output(
        units_output("结尾", ["结", "尾"], [[29_000, 29_500], [29_500, CHUNK_MS + 400]]), CHUNK_MS
    )
    assert segment.end_ms == CHUNK_MS + 400  # merge clips to the audio duration


def test_out_of_order_lines_fail():
    with pytest.raises(NormalizationError, match="starts before the previous"):
        normalize_output(
            units_output(
                "第二。第一。",
                list("第二第一"),
                [[2000, 2500], [2500, 3000], [500, 1000], [1000, 1500]],
            ),
            9000,
        )


def test_overlap_beyond_tolerance_fails_but_small_overlap_is_kept():
    with pytest.raises(NormalizationError, match="overlaps the previous"):
        normalize_output(
            units_output(
                "前面。后面。",
                list("前面后面"),
                [[0, 1000], [1000, 2000], [1800, 2400], [2400, 3000]],
            ),
            9000,
        )
    result = units_output(
        "前面。后面。", list("前面后面"), [[0, 1000], [1000, 2000], [1950, 2400], [2400, 3000]]
    )
    assert [(s, e) for s, e, _ in lines(result, 9000)] == [(0, 2000), (1950, 3000)]


def test_float_times_are_rounded_to_milliseconds():
    assert lines(units_output("小数", ["小", "数"], [[100.4, 500], [500, 899.6]]), 9000) == [
        (100, 900, "小数")
    ]


def test_upstream_sentence_info_shape_problems_still_fail():
    with pytest.raises(NormalizationError, match="not a list"):
        normalize_output([{"key": "c", "text": "", "sentence_info": "x"}], CHUNK_MS)


# --- the alignment flag: a diagnostic only ------------------------------------------------------


def test_alignment_flag_marks_out_of_order_unit_pairs_and_changes_nothing():
    pairs = [[0, 100], [300, 400], [200, 300], [400, 500]]
    [segment] = normalize_output(units_output("一二三四。", list("一二三四"), pairs), CHUNK_MS)
    assert (segment.start_ms, segment.end_ms, segment.text) == (0, 500, "一二三四。")
    assert segment.review_flags == ("timestamp_alignment_anomaly",)


def test_alignment_flag_compares_line_tokens_with_unit_pairs():
    # "U.S." is one recognition unit but two Latin runs, so the token count differs.
    [segment] = normalize_output(
        units_output("U.S.的。", ["U.S.", "的"], [[0, 300], [300, 400]]), CHUNK_MS
    )
    assert segment.review_flags == ("timestamp_alignment_anomaly",)
    assert (segment.start_ms, segment.end_ms) == (0, 400)


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
        [{"key": "chunk", "text": "", "timestamp": [], "raw_text": " "}],
    ],
)
def test_no_speech_in_a_chunk_gives_no_segments(silent):
    assert normalize_output(silent, CHUNK_MS) == []


def test_text_without_unit_timing_fails():
    with pytest.raises(NormalizationError, match="without unit timing"):
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
    # FunASR's sentence_info lost the second sentence, but its units and text are complete:
    # the consistency diagnostic reports that, and the lines come from the units as usual.
    install_models(storage)
    mismatched = [{**NORMAL[0], "sentence_info": NORMAL[0]["sentence_info"][:1]}]
    provider, _ = make_provider(storage, FakeAutoModel(mismatched))
    with caplog.at_level(logging.INFO, logger="pebble.funasr"):
        segments = provider.transcribe(CHUNK, NEVER)
    assert segments == normalize_output(NORMAL, CHUNK_MS)
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
    assert model.calls == [{"sentence_timestamp": True, "return_raw_text": True}] * 2
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
    bad = units_output("没有结束", list("没有结束"), [[0, 1], [1, 2], [2, None], [3, 4]])
    provider, _ = make_provider(storage, FakeAutoModel(bad))
    with pytest.raises(PipelineError) as raised:
        provider.transcribe(CHUNK, NEVER)
    error = raised.value
    assert error.code == FailureCode.PROVIDER_ERROR and error.retryable is False
    assert "unit 3 has no valid time" in error.message
    assert "没有结束" not in error.message  # recognized text never appears in errors


@pytest.mark.parametrize(
    "bad",
    [
        [{"key": "c", "text": "甲乙丙。", "timestamp": [[0, 1], [1, 2], [2, 3]]}],  # no raw_text
        units_output("甲乙丙丁。", ["甲", "乙", "丙"], [[0, 1], [1, 2], [2, 3]]),
        units_output("甲乙丙。", ["甲", "乙", "丙"], [[0, 1], [1, 2]]),
    ],
)
def test_unit_mapping_failure_is_a_safe_internal_error(storage, caplog, bad):
    install_models(storage)
    provider, _ = make_provider(storage, FakeAutoModel(bad))
    with (
        caplog.at_level(logging.INFO, logger="pebble.funasr"),
        pytest.raises(PipelineError) as raised,
    ):
        provider.transcribe(CHUNK, NEVER)
    error = raised.value
    assert error.code == FailureCode.INTERNAL_ERROR and error.retryable is True
    assert "section 1" in error.message
    messages = [r.getMessage() for r in caplog.records]
    assert any("unit mapping failed" in m for m in messages)
    for text in [error.message, error.hint or "", *messages]:
        assert not any(c in text for c in "甲乙丙丁")  # never recognized or raw text


def test_raw_unit_text_is_never_logged_kept_or_returned(storage, caplog):
    install_models(storage)
    provider, _ = make_provider(storage, FakeAutoModel(TWO_VAD))
    with caplog.at_level(logging.DEBUG, logger="pebble.funasr"):
        segments = provider.transcribe(CHUNK, NEVER)
    raw = TWO_VAD[0]["raw_text"]
    assert raw == "甲 乙 丙 丁 戊"
    assert not any(c in r.getMessage() for r in caplog.records for c in "甲乙丙丁戊")
    stored = json.dumps([s.__dict__ for s in segments], ensure_ascii=False)  # what jobs persist
    assert "raw_text" not in stored and raw not in stored
    assert {f for s in segments for f in vars(s)} == {
        "start_ms",
        "end_ms",
        "text",
        "confidence",
        "speaker",
        "review_flags",
    }
    assert not any(raw in repr(value) for value in vars(provider).values())
    payload = merge(
        episode_id="ep-0123456789ab",
        duration_ms=CHUNK_MS,
        language="zh-CN",
        chunks=[ChunkResult(0, segments, index=0)],
        provider=provider,
    ).dump()
    dumped = json.dumps(payload, ensure_ascii=False)  # what the API serves
    assert "raw_text" not in dumped and raw not in dumped


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
    # A long line whose unit pairs are out of order: flagged, never changed.
    pairs = per_char(200, 7600, 11)
    pairs[4], pairs[5] = pairs[5], pairs[4]
    second = normalize_output(
        units_output("这是一句很长很长的句子。", list("这是一句很长很长的句子"), pairs), CHUNK_MS
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
