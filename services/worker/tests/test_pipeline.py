"""Probe, normalize, silence detection, chunk planning/writing, merge — on generated audio."""

from __future__ import annotations

import random
import wave
from itertools import pairwise
from pathlib import Path

import pytest
from conftest import TEST_CHUNKING

from pebble_worker.config import ChunkingConfig
from pebble_worker.errors import Cancelled, FailureCode, PipelineError
from pebble_worker.pipeline.chunk import (
    Silence,
    check_chunk_spans,
    detect_silences,
    parse_silences,
    plan_chunks,
    write_chunks,
)
from pebble_worker.pipeline.merge import ChunkResult, MergeReport, merge, merge_with_report
from pebble_worker.pipeline.normalize import normalize, wav_duration_ms
from pebble_worker.pipeline.probe import probe
from pebble_worker.pipeline.tools import run_tool
from pebble_worker.providers.base import RawSegment
from pebble_worker.providers.mock import MockProvider

FOUR_HOURS = 4 * 3600


# --- probe ----------------------------------------------------------------------------------


def test_probe_reads_duration_and_codec(audio):
    result = probe(audio["tone_gaps"], ffprobe="ffprobe", max_seconds=FOUR_HOURS)
    assert abs(result.duration_ms - 14_000) < 100
    assert result.codec == "aac"


@pytest.mark.parametrize(
    ("name", "code"),
    [("not_audio", FailureCode.UNSUPPORTED_MEDIA), ("video_only", FailureCode.NO_AUDIO_STREAM)],
)
def test_probe_rejects_non_audio(audio, name, code):
    with pytest.raises(PipelineError) as error:
        probe(audio[name], ffprobe="ffprobe", max_seconds=FOUR_HOURS)
    assert error.value.code == code
    assert error.value.retryable is False


def test_probe_enforces_the_duration_limit(audio):
    with pytest.raises(PipelineError) as error:
        probe(audio["tone"], ffprobe="ffprobe", max_seconds=5)
    assert error.value.code == FailureCode.AUDIO_TOO_LONG
    assert error.value.hint


def test_missing_ffmpeg_is_a_structured_failure(audio):
    with pytest.raises(PipelineError) as error:
        probe(audio["tone"], ffprobe="/nonexistent/ffprobe", max_seconds=FOUR_HOURS)
    assert error.value.code == FailureCode.FFMPEG_NOT_FOUND
    assert error.value.retryable is True


def test_running_tools_can_be_cancelled():
    with pytest.raises(Cancelled):
        run_tool(["sleep", "5"], cancel=lambda: True)


# --- normalize -------------------------------------------------------------------------------


def test_normalize_produces_16k_mono_pcm(audio, tmp_path):
    target = tmp_path / "normalized.wav"
    duration = normalize(audio["tone_gaps"], target, ffmpeg="ffmpeg")
    with wave.open(str(target)) as wav:
        assert (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) == (16_000, 1, 2)
    assert abs(duration - 14_000) < 100
    assert target.stat().st_mode & 0o777 == 0o600


def test_normalize_rejects_undecodable_input(audio, tmp_path):
    with pytest.raises(PipelineError) as error:
        normalize(audio["not_audio"], tmp_path / "out.wav", ffmpeg="ffmpeg")
    assert error.value.code == FailureCode.UNSUPPORTED_MEDIA


# --- silence detection & planning ------------------------------------------------------------


@pytest.fixture
def normalized_gaps(audio, tmp_path) -> tuple[Path, int]:
    target = tmp_path / "gaps.wav"
    return target, normalize(audio["tone_gaps"], target, ffmpeg="ffmpeg")


def test_detects_the_generated_silences(normalized_gaps):
    path, duration = normalized_gaps
    silences = detect_silences(path, duration, TEST_CHUNKING, ffmpeg="ffmpeg")
    mids = [s.mid_ms for s in silences]
    assert len(mids) == 5
    for found, expected in zip(mids, [2250, 4750, 7250, 9750, 12250], strict=True):
        assert abs(found - expected) < 120


def test_parse_silences_closes_a_trailing_silence():
    log = "silence_start: 1.5\nsilence_end: 2.0 | silence_duration: 0.5\nsilence_start: 9.2\n"
    assert parse_silences(log, 10_000) == [Silence(1500, 2000), Silence(9200, 10_000)]


def test_cuts_at_silence_near_the_target(normalized_gaps):
    path, duration = normalized_gaps
    silences = detect_silences(path, duration, TEST_CHUNKING, ffmpeg="ffmpeg")
    plans = plan_chunks(duration, silences, TEST_CHUNKING)
    assert [p.cut for p in plans] == ["silence"] * 5 + ["end"]
    for plan, expected in zip(plans, [2250, 4750, 7250, 9750, 12250], strict=False):
        assert abs(plan.end_ms - expected) < 120


def test_hard_cut_fallback_without_silence(audio, tmp_path):
    target = tmp_path / "tone.wav"
    duration = normalize(audio["tone"], target, ffmpeg="ffmpeg")
    silences = detect_silences(target, duration, TEST_CHUNKING, ffmpeg="ffmpeg")
    assert silences == []
    plans = plan_chunks(duration, silences, TEST_CHUNKING)
    assert [(p.start_ms, p.end_ms, p.cut) for p in plans] == [
        (0, 3000, "hard"),
        (3000, 6000, "hard"),
        (6000, duration, "end"),
    ]


DEFAULTS = ChunkingConfig()  # target 150 s, range 120–240 s


def test_default_config_prefers_silence_closest_to_target():
    silences = [Silence(125_000, 125_600), Silence(152_000, 152_400), Silence(230_000, 230_500)]
    plans = plan_chunks(400_000, silences, DEFAULTS)
    assert plans[0].end_ms == 152_200 and plans[0].cut == "silence"


def test_default_config_ignores_silence_outside_the_window():
    # Silences at 60 s and 300 s are outside [120, 240] → hard cut at the 150 s target.
    plans = plan_chunks(400_000, [Silence(60_000, 61_000), Silence(300_000, 301_000)], DEFAULTS)
    assert (plans[0].end_ms, plans[0].cut) == (150_000, "hard")


def test_default_config_never_exceeds_max_and_covers_everything():
    duration = 3_600_000  # one hour, no silences
    plans = plan_chunks(duration, [], DEFAULTS)
    assert all(p.end_ms - p.start_ms <= 240_000 for p in plans)
    assert plans[0].start_ms == 0 and plans[-1].end_ms == duration
    assert all(a.end_ms == b.start_ms for a, b in pairwise(plans))


def test_short_audio_is_a_single_chunk():
    assert [(p.start_ms, p.end_ms, p.cut) for p in plan_chunks(90_000, [], DEFAULTS)] == [
        (0, 90_000, "end")
    ]


def test_chunks_are_sample_exact_and_contiguous(normalized_gaps, tmp_path):
    path, duration = normalized_gaps
    plans = plan_chunks(
        duration, detect_silences(path, duration, TEST_CHUNKING, ffmpeg="ffmpeg"), TEST_CHUNKING
    )
    out = tmp_path / "chunks"
    out.mkdir()
    paths = write_chunks(path, plans, out)
    with wave.open(str(path)) as source:
        total = source.getnframes()
    frames = 0
    for chunk_path in paths:
        with wave.open(str(chunk_path)) as chunk:
            assert (chunk.getframerate(), chunk.getnchannels()) == (16_000, 1)
            frames += chunk.getnframes()
        assert chunk_path.stat().st_mode & 0o777 == 0o600
    assert frames == total  # no gaps, no overlap
    assert abs(sum(wav_duration_ms(p) for p in paths) - duration) <= len(paths)


def test_chunk_writing_stops_when_cancelled(normalized_gaps, tmp_path):
    path, duration = normalized_gaps
    plans = plan_chunks(duration, [], TEST_CHUNKING)
    with pytest.raises(Cancelled):
        write_chunks(path, plans, tmp_path, cancel=lambda: True)


# --- merge -----------------------------------------------------------------------------------


def test_merge_offsets_renumbers_clamps_and_validates():
    # The second chunk is 3000–7000 ms. "第四" ends 300 ms past it: within the 500 ms bound
    # tolerance, so it is kept and its end is capped at the audio duration (and counted).
    # (This test used to end that line 5 s past its chunk; that is now a structural failure,
    # see test_merge_rejects_a_line_beyond_its_chunk.)
    provider = MockProvider()
    transcript, report = merge_with_report(
        episode_id="ep-0123456789ab",
        duration_ms=7_000,
        language="zh-CN",
        chunks=[
            ChunkResult(
                0,
                [RawSegment(0, 2000, "第一"), RawSegment(2000, 3000, "第二")],
                index=0,
                end_ms=3000,
            ),
            ChunkResult(
                3000,
                [
                    RawSegment(0, 2500, "第三"),
                    RawSegment(2500, 4300, "第四"),
                    RawSegment(100, 100, "zero length"),
                    RawSegment(0, 500, "  "),
                ],
                index=1,
                end_ms=7000,
            ),
        ],
        provider=provider,
    )
    rows = [(s.id, s.index, s.start_ms, s.end_ms, s.text) for s in transcript.segments]
    assert rows == [
        ("seg-0001", 0, 0, 2000, "第一"),
        ("seg-0002", 1, 2000, 3000, "第二"),
        ("seg-0003", 2, 3000, 5500, "第三"),
        ("seg-0004", 3, 5500, 7000, "第四"),  # clamped to the audio duration
    ]
    assert report == MergeReport(
        kept=4,
        dropped_empty_text=1,
        dropped_zero_length=1,
        dropped_past_duration=0,
        clamped_to_duration=1,
        overlaps=0,
        max_overlap_ms=0,
    )
    assert transcript.provenance.kind == "mock"
    assert transcript.provenance.provider == "mock"
    assert all(s.confidence is None for s in transcript.segments)


def _merge(chunks, duration_ms=10_000):
    return merge_with_report(
        episode_id="ep-0123456789ab",
        duration_ms=duration_ms,
        language="zh-CN",
        chunks=chunks,
        provider=MockProvider(),
    )


def _structural(chunks, duration_ms=10_000):
    with pytest.raises(PipelineError) as error:
        _merge(chunks, duration_ms)
    assert error.value.code == FailureCode.INTERNAL_ERROR
    assert "第" not in error.value.message  # never any text
    return error.value


@pytest.mark.parametrize(
    "raw",
    [
        RawSegment(2500, 4501, "第五"),  # ends past the 500 ms tolerance
        RawSegment(4000, 4200, "第五"),  # starts at the chunk's end
        RawSegment(4100, 4200, "第五"),  # starts after it
    ],
)
def test_merge_rejects_a_line_beyond_its_chunk(raw):
    _structural([ChunkResult(0, [raw], index=0, end_ms=4000)], duration_ms=4000)


def test_merge_keeps_a_line_ending_exactly_at_the_tolerance():
    transcript, _ = _merge(
        [ChunkResult(0, [RawSegment(2500, 4500, "第五")], index=0, end_ms=4000)],
        duration_ms=6000,
    )
    assert [(s.start_ms, s.end_ms) for s in transcript.segments] == [(2500, 4500)]


@pytest.mark.parametrize(
    "raw",
    [
        RawSegment(900, 800, "第六"),  # negative length
        RawSegment(900, 800, "  "),  # negative length is checked before empty text
        RawSegment(-10, 800, "第六"),  # negative start
    ],
)
def test_merge_rejects_invalid_timing_before_dropping_anything(raw):
    _structural([ChunkResult(0, [raw], index=0, end_ms=4000)])


def test_merge_check_order_drops_empty_and_zero_length_lines_before_range_checks():
    # Both would be out of range, but empty text and zero length are dropped first (counted).
    transcript, report = _merge(
        [
            ChunkResult(
                0,
                [
                    RawSegment(0, 900, "第一"),
                    RawSegment(5000, 9000, " "),
                    RawSegment(5000, 5000, "第二"),
                ],
                index=0,
                end_ms=4000,
            )
        ]
    )
    assert len(transcript.segments) == 1
    assert (report.dropped_empty_text, report.dropped_zero_length) == (1, 1)


def test_merge_counts_lines_left_empty_by_the_duration_cap():
    # Without a known chunk end (benchmark overlap runs), a line may start past the audio.
    transcript, report = _merge(
        [ChunkResult(0, [RawSegment(0, 900, "第一"), RawSegment(5000, 5200, "第二")])],
        duration_ms=4000,
    )
    assert len(transcript.segments) == 1
    assert (report.dropped_past_duration, report.clamped_to_duration) == (1, 1)


def test_merge_rejects_duplicate_and_missing_chunk_indices():
    one = [RawSegment(0, 900, "第一")]
    _structural([ChunkResult(0, one, index=0), ChunkResult(1000, one, index=0)])
    _structural([ChunkResult(0, one, index=0), ChunkResult(1000, one, index=2)])


def test_merge_orders_chunks_given_out_of_order_and_counts_overlaps():
    transcript, report = _merge(
        [
            ChunkResult(4000, [RawSegment(0, 1000, "第三")], index=1, end_ms=8000),
            ChunkResult(
                0,
                [RawSegment(0, 2000, "第一"), RawSegment(1950, 4300, "第二")],
                index=0,
                end_ms=4000,
            ),
        ]
    )
    assert [(s.start_ms, s.end_ms, s.text) for s in transcript.segments] == [
        (0, 2000, "第一"),
        (1950, 4300, "第二"),
        (4000, 5000, "第三"),
    ]
    assert (report.overlaps, report.max_overlap_ms) == (2, 300)
    assert "第" not in str(report)  # numbers only


def test_plain_merge_still_returns_just_the_transcript():
    transcript = merge(
        episode_id="ep-0123456789ab",
        duration_ms=4000,
        language="zh-CN",
        chunks=[ChunkResult(0, [RawSegment(0, 900, "第一")], index=0, end_ms=4000)],
        provider=MockProvider(),
    )
    assert [s.text for s in transcript.segments] == ["第一"]


# --- chunk spans ---------------------------------------------------------------------------------


def test_every_planned_chunk_set_tiles_the_audio():
    rng = random.Random(7)
    for _ in range(300):
        duration = rng.randint(1, 3_000_000)
        starts = sorted(rng.sample(range(duration), min(duration, rng.randint(0, 40))))
        silences = [
            Silence(start, min(duration, start + rng.randint(400, 3000))) for start in starts
        ]
        for config in (DEFAULTS, TEST_CHUNKING):
            plans = plan_chunks(duration, silences, config)
            check_chunk_spans([(p.index, p.start_ms, p.end_ms) for p in plans], duration)


@pytest.mark.parametrize(
    "spans",
    [
        [],  # nothing
        [(0, 100, 5000), (1, 5000, 10_000)],  # doesn't start at 0
        [(0, 0, 5000), (1, 5100, 10_000)],  # gap
        [(0, 0, 5000), (1, 4900, 10_000)],  # overlap
        [(0, 0, 5000), (0, 5000, 10_000)],  # duplicate index
        [(1, 0, 5000), (0, 5000, 10_000)],  # out of order
        [(0, 0, 5000), (2, 5000, 10_000)],  # missing index
        [(0, 0, 5000), (1, 5000, 5000), (2, 5000, 10_000)],  # empty chunk
        [(0, 0, 5000), (1, 5000, 9000)],  # stops short of the audio
        [(0, 0, 5000), (1, 5000, 11_000)],  # runs past it
    ],
)
def test_chunk_spans_that_dont_tile_the_audio_are_structural_failures(spans):
    with pytest.raises(PipelineError) as error:
        check_chunk_spans(spans, 10_000)
    assert error.value.code == FailureCode.INTERNAL_ERROR


# --- mock provider ---------------------------------------------------------------------------


def test_mock_segments_cover_the_chunk_and_fold_short_tails(tmp_path):
    from pebble_worker.providers.base import AudioChunk

    chunk = AudioChunk(index=1, start_ms=0, end_ms=8_500, path=tmp_path / "x.wav")
    segments = MockProvider(delay_ms=0).transcribe(chunk, lambda: False)
    assert [(s.start_ms, s.end_ms) for s in segments] == [(0, 4000), (4000, 8500)]
    assert segments[0].text == "（模拟转写）第 2-1 段"
    assert all(s.confidence is None for s in segments)


def test_mock_can_simulate_failure_and_honours_cancel(tmp_path):
    from pebble_worker.providers.base import AudioChunk

    chunk = AudioChunk(index=1, start_ms=0, end_ms=4000, path=tmp_path / "x.wav")
    with pytest.raises(PipelineError) as error:
        MockProvider(delay_ms=0, fail_at_chunk=2).transcribe(chunk, lambda: False)
    assert error.value.code == FailureCode.PROVIDER_ERROR and error.value.retryable
    with pytest.raises(Cancelled):
        MockProvider(delay_ms=1000).transcribe(chunk, lambda: True)
