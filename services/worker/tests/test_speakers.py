"""
The speaker diarization core (ADR 0009) on invented data only: tone audio written here, fake
embedders and clusterers, fake model files. No model weights load and every socket is blocked.
"""

from __future__ import annotations

import dataclasses
import hashlib
import socket
import wave
from pathlib import Path

import pytest

from pebble_worker.errors import Cancelled
from pebble_worker.models.manifest import ModelFile, ModelSpec
from pebble_worker.models.verify import file_path
from pebble_worker.speakers import core
from pebble_worker.speakers.campplus import CampplusEmbedder, FunasrClusterer
from pebble_worker.speakers.core import LineSpan, SpeakerRunError
from pebble_worker.storage import Storage

numpy = pytest.importorskip("numpy")

LINE_MS = 2500
#: Invented "voices": a tone per speaker. Line i is spoken by VOICES[PATTERN[i]].
VOICES = (220.0, 660.0)
PATTERN = (0, 0, 1, 1, 1, 0, 1, 0, 0, 1)


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the speaker core must not use the network")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket.socket, "connect_ex", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
    monkeypatch.setattr(socket, "getaddrinfo", refuse)


def write_wav(path: Path, pattern=PATTERN, *, channels: int = 1, rate: int = 16000) -> Path:
    t = numpy.arange(LINE_MS * rate // 1000) / rate
    signal = numpy.concatenate([0.4 * numpy.sin(2 * numpy.pi * VOICES[v] * t) for v in pattern])
    frames = (signal * 32767).astype("<i2")
    if channels == 2:
        frames = numpy.repeat(frames, 2)
    with wave.open(str(path), "wb") as out:
        out.setparams((channels, 2, rate, 0, "NONE", "not compressed"))
        out.writeframes(frames.tobytes())
    return path


def lines(count: int = len(PATTERN)) -> list[LineSpan]:
    return [LineSpan(f"seg-{i + 1:04d}", i * LINE_MS, (i + 1) * LINE_MS) for i in range(count)]


class ToneEmbedder:
    """A fake embedder: each window's dominant frequency, as a 2-D vector."""

    def __init__(self) -> None:
        self.calls: list[int] = []

    def __call__(self, windows):
        self.calls.append(len(windows))
        assert all(w.dtype == numpy.float32 and w.shape == (core.WINDOW_SAMPLES,) for w in windows)
        peaks = [numpy.argmax(numpy.abs(numpy.fft.rfft(w))) * 16000 / len(w) for w in windows]
        return numpy.array([[p / 1000, 1.0] for p in peaks], dtype=numpy.float32)


def tone_clusterer(embeddings):
    """Fake: high tone → label 3, low tone → label 9 (numbers chosen not to match the IDs)."""
    return [3 if row[0] > 0.44 else 9 for row in embeddings], "fake"


def run(tmp_path, *, audio=None, spans=None, **overrides):
    arguments = {"embedder": ToneEmbedder(), "clusterer": tone_clusterer, **overrides}
    return core.diarize(audio or write_wav(tmp_path / "audio.wav"), spans or lines(), **arguments)


# --- windows ------------------------------------------------------------------------------------


def test_window_spans_match_the_installed_sv_chunk():
    utils = pytest.importorskip("funasr.models.campplus.utils")
    for ms in (200, 1499, 1500, 1501, 2250, 2251, 3000, 9999, 60000):
        region = numpy.zeros(ms * 16, dtype=numpy.float32)
        theirs = [
            (round(s * 16000), round(e * 16000)) for s, e, _ in utils.sv_chunk([[0.0, 0, region]])
        ]
        assert core.window_spans(len(region)) == theirs, ms
    assert (
        core.window_count(LINE_MS) == 3
        and core.window_count(1000) == 1
        and core.window_count(0) == 0
    )


# --- labels -------------------------------------------------------------------------------------


def test_ids_follow_first_appearance_whatever_the_clusterer_numbering():
    window_lines = [0, 0, 1, 1, 2, 2, 3]
    for labels in ([4, 4, 1, 1, 4, 4, 7], [0, 0, 2, 2, 0, 0, 1], [9, 9, 5, 5, 9, 9, 6]):
        speakers, names = core.assign_lines(window_lines, labels, 5)
        assert speakers == ["S1", "S2", "S1", "S3", None]  # line 4 has no windows
        assert sorted(names.values()) == ["S1", "S2", "S3"]


def test_majority_ties_and_noise():
    # line 0: 2 vs 2 → the label heard first; line 1: noise ignored; line 2: only noise.
    speakers, _ = core.assign_lines([0, 0, 0, 0, 1, 1, 1, 2], [5, 6, 6, 5, -1, 6, -1, -1], 3)
    assert speakers == ["S1", "S2", None]


# --- whole runs ---------------------------------------------------------------------------------


def test_one_episode_wide_clustering_keeps_identity_across_the_episode(tmp_path):
    result = run(tmp_path)
    expected = ["S1" if voice == 0 else "S2" for voice in PATTERN]
    assert list(result.assignments) == [line.segment_id for line in lines()]  # ids, in order
    assert list(result.assignments.values()) == expected  # S1 early and late is one speaker
    assert [(s.id, s.lines, s.windows) for s in result.speakers] == [("S1", 5, 15), ("S2", 5, 15)]
    assert (result.windows, result.noise_windows, result.unassigned_lines) == (30, 0, 0)
    assert result.clustering == "fake"


def test_the_core_never_sees_or_returns_text_or_embeddings(tmp_path):
    assert [f.name for f in dataclasses.fields(LineSpan)] == ["segment_id", "start_ms", "end_ms"]
    result = run(tmp_path)
    values = [getattr(result, f.name) for f in dataclasses.fields(result)]
    assert not any(isinstance(v, numpy.ndarray) for v in values)


def test_lines_past_the_audio_and_noise_only_lines_are_unassigned(tmp_path):
    spans = [*lines(), LineSpan("seg-past", 60_000, 61_000)]

    def noisy(embeddings):
        labels, _ = tone_clusterer(embeddings)
        labels[:3] = [-1, -1, -1]  # every window of the first line
        return labels, "fake"

    result = run(tmp_path, spans=spans, clusterer=noisy)
    assert result.assignments["seg-0001"] is None and result.assignments["seg-past"] is None
    assert result.unassigned_lines == 2 and result.noise_windows == 3


def test_embeddings_are_extracted_once_in_batches(tmp_path):
    embedder = ToneEmbedder()
    seen = []

    def clusterer(embeddings):
        seen.append(embeddings.shape)
        return tone_clusterer(embeddings)

    run(tmp_path, embedder=embedder, clusterer=clusterer, batch_size=7)
    assert embedder.calls == [7, 7, 7, 7, 2] and seen == [(30, 2)]


def test_no_windows_means_no_clustering(tmp_path):
    def never(embeddings):
        raise AssertionError("nothing to cluster")

    result = run(tmp_path, spans=[LineSpan("seg-x", 90_000, 91_000)], clusterer=never)
    assert result.assignments == {"seg-x": None} and result.clustering == "none"


#: With 10 lines, 30 windows and batches of 4, a run checks for cancellation 21 times: once at the
#: start, before each line is read (10), before each of the 8 embedding batches, and before and
#: after clustering. Cancelling at check n+1 must stop the run at that checkpoint.
CHECKS = 21


@pytest.mark.parametrize("after", [0, 1, 5, 12, CHECKS - 2, CHECKS - 1])
def test_cancellation_is_honoured_at_every_kind_of_checkpoint(tmp_path, after):
    checks = {"n": 0}

    def cancel():
        checks["n"] += 1
        return checks["n"] > after

    with pytest.raises(Cancelled):
        run(tmp_path, cancel=cancel, batch_size=4)
    assert checks["n"] == after + 1


def test_a_run_that_is_never_cancelled_checks_exactly_that_often(tmp_path):
    checks = {"n": 0}

    def cancel():
        checks["n"] += 1
        return False

    run(tmp_path, cancel=cancel, batch_size=4)
    assert checks["n"] == CHECKS


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"embedder": lambda w: (_ for _ in ()).throw(RuntimeError())}, "EMBEDDING_FAILED"),
        ({"embedder": lambda w: numpy.zeros((1, 2))}, "EMBEDDING_FAILED"),
        ({"embedder": lambda w: numpy.full((len(w), 2), numpy.nan)}, "EMBEDDING_FAILED"),
        ({"clusterer": lambda e: (_ for _ in ()).throw(ValueError())}, "CLUSTERING_FAILED"),
        ({"clusterer": lambda e: ([0], "fake")}, "CLUSTERING_FAILED"),
        ({"spans": [LineSpan("a", 0, 10), LineSpan("a", 10, 20)]}, "INVALID_INPUT"),
        ({"spans": [LineSpan("a", 10, 10)]}, "INVALID_INPUT"),
    ],
)
def test_failures_are_clear_and_contain_no_details(tmp_path, overrides, code):
    with pytest.raises(SpeakerRunError) as raised:
        run(tmp_path, **overrides)
    assert raised.value.code == code
    assert str(tmp_path) not in raised.value.message


def test_unreadable_or_wrong_format_audio(tmp_path):
    (tmp_path / "x.wav").write_bytes(b"not audio")
    with pytest.raises(SpeakerRunError) as raised:
        run(tmp_path, audio=tmp_path / "x.wav")
    assert raised.value.code == "AUDIO_UNAVAILABLE" and raised.value.retryable
    stereo = write_wav(tmp_path / "stereo.wav", channels=2)
    with pytest.raises(SpeakerRunError) as raised:
        run(tmp_path, audio=stereo)
    assert raised.value.code == "AUDIO_UNAVAILABLE" and not raised.value.retryable


# --- temporary audio ----------------------------------------------------------------------------


def test_temporary_normalized_audio_is_always_removed(tmp_path):
    scratch = tmp_path / "tmp"

    def normalize(source, target):
        write_wav(target)
        return len(PATTERN) * LINE_MS

    with core.temporary_normalized(tmp_path / "source.m4a", scratch, normalize) as audio:
        assert audio.is_file() and audio.parent.parent == scratch
        assert (audio.parent.stat().st_mode & 0o777) == 0o700
    assert list(scratch.iterdir()) == []

    with pytest.raises(Cancelled), core.temporary_normalized(tmp_path / "s", scratch, normalize):
        raise Cancelled()
    assert list(scratch.iterdir()) == []

    def broken(source, target):
        target.write_bytes(b"partial")
        raise RuntimeError("ffmpeg failed")

    with (
        pytest.raises(SpeakerRunError) as raised,
        core.temporary_normalized(tmp_path / "s", scratch, broken),
    ):
        pass
    assert raised.value.code == "AUDIO_UNAVAILABLE"
    assert list(scratch.iterdir()) == []


# --- the CAM++ adapter with fake model files ----------------------------------------------------

CONTENTS = {"configuration.json": b"{}", "config.yaml": b"model: X", "weights.bin": b"WEIGHTS"}


def fake_spec() -> ModelSpec:
    files = tuple(ModelFile(n, len(c), hashlib.sha256(c).hexdigest()) for n, c in CONTENTS.items())
    return ModelSpec("speaker", "test/fake-speaker", "v0.0.1", "Apache-2.0", "-", "-", files, 0)


def install(storage: Storage, spec: ModelSpec, contents=CONTENTS) -> None:
    for f in spec.files:
        path = file_path(storage, spec, f)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(contents[f.path])


def test_missing_model_is_reported_without_loading_anything(tmp_path):
    storage, spec = Storage(tmp_path / "pebble"), fake_spec()
    embedder = CampplusEmbedder(storage, spec=spec, loader=lambda d: pytest.fail("loaded"))
    assert embedder.state() == "missing"
    with pytest.raises(SpeakerRunError) as raised:
        embedder([numpy.zeros(core.WINDOW_SAMPLES, numpy.float32)])
    assert raised.value.code == "SPEAKER_MODEL_UNAVAILABLE" and "--speaker" in raised.value.message


def test_model_loads_lazily_once_from_its_verified_local_folder(tmp_path):
    storage, spec = Storage(tmp_path / "pebble"), fake_spec()
    install(storage, spec)
    loads = []

    def loader(directory):
        loads.append(directory)
        return lambda windows: numpy.ones((len(windows), 2), numpy.float32)

    embedder = CampplusEmbedder(storage, spec=spec, loader=loader)
    assert embedder.state() == "ready" and loads == []  # state() never loads
    window = [numpy.zeros(core.WINDOW_SAMPLES, numpy.float32)]
    embedder(window)
    embedder(window)
    assert loads == [storage.root / "models" / "test" / "fake-speaker"]


def test_tampered_or_failing_model_is_unavailable(tmp_path):
    storage, spec = Storage(tmp_path / "pebble"), fake_spec()
    install(storage, spec, {**CONTENTS, "weights.bin": b"weights"})  # same size, wrong hash
    assert CampplusEmbedder(storage, spec=spec).state() == "ready"  # cheap check can't tell
    with pytest.raises(SpeakerRunError, match="failed verification"):
        CampplusEmbedder(storage, spec=spec, loader=lambda d: pytest.fail("loaded"))([])
    install(storage, spec, {**CONTENTS, "weights.bin": b"W"})
    assert CampplusEmbedder(storage, spec=spec).state() == "incomplete"
    install(storage, spec)

    def broken(directory):
        raise RuntimeError("bad weights")

    with pytest.raises(SpeakerRunError, match="couldn't be loaded"):
        CampplusEmbedder(storage, spec=spec, loader=broken)([])


# --- FunASR's installed clusterer on synthetic embeddings (no model) ------------------------------


def test_installed_clusterer_finds_two_synthetic_speakers_deterministically(tmp_path, monkeypatch):
    pytest.importorskip("funasr.models.campplus.cluster_backend")
    monkeypatch.delenv("NUMBA_CACHE_DIR", raising=False)
    rng = numpy.random.default_rng(0)
    centres = rng.normal(size=(2, 192))
    rows = numpy.concatenate(
        [centres[i] + 0.05 * rng.normal(size=(150, 192)) for i in (1, 0)]
    ).astype(numpy.float32)
    cache = tmp_path / "scratch" / "numba"
    clusterer = FunasrClusterer(cache)
    labels, branch = clusterer(rows.copy())
    again, _ = clusterer(rows.copy())
    assert branch == "spectral" and labels == again
    speakers, _ = core.assign_lines(list(range(300)), labels, 300)
    assert set(speakers[:150]) == {"S1"} and set(speakers[150:]) == {"S2"}
    assert cache.is_dir()  # run-local; nothing is created under the data folder
    few, branch = clusterer(rows[:10].copy())
    assert branch == "single" and set(few) == {0}


def test_translation_code_never_imports_the_speaker_core():
    source = Path(__file__).resolve().parents[1] / "src" / "pebble_worker" / "translation"
    assert all("speakers" not in p.read_text(encoding="utf-8") for p in source.glob("*.py"))
