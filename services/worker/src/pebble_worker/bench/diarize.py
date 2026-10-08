"""
Benchmark-only speaker diarization evaluation (ADR 0009): `bench diarize` and `bench diarize-score`.

One explicitly named local episode is read, never written: its stored transcript and audio come
from the data directory (the database is opened read-only). Every transcript line is cut into the
speech windows FunASR's own diarization uses, each window is embedded with the pinned CAM++ model,
and all of the episode's windows are clustered **once**, so speaker identity holds across the whole
episode rather than restarting per ASR chunk. Each line then gets the speaker that holds most of its
windows, and a `mixed` flag when a second speaker holds a meaningful share (an estimate of more than
one turn, not verified overlapping speech).

Embeddings stay in memory and are discarded. Only the private run directory
`<data>/benchmarks/diarize/<run>/` is written: numbers (`result.json`), per-line labels and the
review selection without text (`key.json`), a blind review sheet that does contain text
(`review.md`, private like every other review file) and, after review, `score.json`.
"""

from __future__ import annotations

import contextlib
import importlib.metadata
import json
import math
import os
import random
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import time
import wave
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..config import Settings
from ..contract import parse_transcript
from ..errors import StorageAccessError
from ..models.manifest import CAMPPLUS_SV_ZH
from ..models.pull import hub_environment
from ..models.verify import model_dir, verify_model
from ..pipeline.normalize import normalize
from ..storage import PRIVATE_DIR, Storage, make_private
from . import network
from .memory import MemorySampler
from .paths import safe_path

FORMAT = "pebble-diarize-bench/1"

# FunASR 1.4.16 `funasr/models/campplus/utils.py::sv_chunk` (used as is) and
# `cluster_backend.py::ClusterBackend` (used as is, with its default merge threshold).
WINDOW_MS = 1500
SHIFT_MS = 750
MERGE_THRESHOLD = 0.78
SINGLE_SPEAKER_BELOW = 20  # windows: fewer → every window is speaker 0
SPECTRAL_BELOW = 2048  # windows: fewer → spectral; more → k-means (hint) or UMAP+HDBSCAN (auto)
MAX_SPEAKERS = 15  # the spectral clusterer's eigengap search range is 1…15
NOISE = -1  # HDBSCAN's "no cluster" label; Pebble keeps it out of line votes

# Pebble's line rule (starting points; the evaluation reports how well they work).
MIXED_MIN_WINDOWS = 2
MIXED_MIN_SHARE = 0.25
LONG_LINE_MS = 2000
SHORT_REPLY_MS = 1500
MINOR_CLUSTER_SHARE = 0.02
REPEATS = 3  # auto clustering is repeated with seed, seed+1, seed+2 to measure stability

DEFAULT_LINES = 50
MIN_LINES, MAX_LINES = 40, 60
STRATA = (("short", 0.20), ("transition", 0.24), ("difficult", 0.20))  # the rest: "spread"

#: Proposed targets (ADR 0009), not established performance.
PROPOSED_TARGETS = {
    "longLineAccuracy": 0.90,
    "minutesPerAudioHour": 5.0,
    "peakMemoryBytes": 2 * 1024**3,
}

SPEAKER_OPTIONS = ("A", "B", "C", "D", "E", "F", "other", "unsure")
TURN_OPTIONS = ("one speaker", "two or more", "unsure")

DIARIZE_DIRNAME = "diarize"
RUN_ID = re.compile(r"^\d{8}T\d{6}Z-ep-[0-9a-f]{12}$")
RUN_FILES = (
    "result.json",
    "key.json",
    "review.md",
    "score.json",
    "normalized.wav",
    "targeted-review.md",
    "targeted-key.json",
    "targeted-score.json",
)
EMBED_BATCH = 64

#: A finite wall-clock deadline for the whole run (normalize, load, embed, cluster, write).
DEFAULT_DEADLINE_MINUTES = 30
MIN_DEADLINE_MINUTES, MAX_DEADLINE_MINUTES = 5, 60
#: After the deadline, the parent waits this long for the child's own cleanup, then kills it.
KILL_GRACE_SECONDS = 60
#: numba (used by UMAP and pynndescent with `cache=True`) writes compiled-function caches. The
#: child points them here, inside the run folder, and the parent deletes it on every exit path,
#: so nothing is written into the Python environment. Bytecode writing is off for the same reason.
NUMBA_CACHE_DIRNAME = "numba-cache"

Embedder = Callable[[list[Any]], Any]  # windows (float32 arrays) → (n, dim) array
#: embeddings, hint, seed → (labels, the clustering branch that actually ran)
Clusterer = Callable[[Any, int | None, int], tuple[list[int], str]]


class DiarizeError(Exception):
    """A clear refusal; the message never contains transcript text or private paths."""


class DeadlineExceeded(DiarizeError):
    def __init__(self, stage: str) -> None:
        super().__init__(
            f"The run reached its deadline during {stage}; partial files were removed."
        )
        self.stage = stage


# --- locations ----------------------------------------------------------------------------------


def diarize_root(storage: Storage) -> Path:
    return safe_path(storage, storage.root / "benchmarks" / DIARIZE_DIRNAME)


def run_file(storage: Storage, run_id: str, name: str) -> Path:
    if not RUN_ID.match(run_id):
        raise StorageAccessError(f"Invalid diarization run id: {run_id!r}")
    if name not in RUN_FILES:
        raise StorageAccessError(f"Unknown diarization run file: {name!r}")
    return safe_path(storage, diarize_root(storage) / run_id / name)


def new_run_id(episode_id: str, now: datetime | None = None) -> str:
    return f"{(now or datetime.now(UTC)).strftime('%Y%m%dT%H%M%SZ')}-{episode_id}"


def create_run_dir(storage: Storage, run_id: str) -> Path:
    storage.ensure()
    for directory in (storage.root / "benchmarks", diarize_root(storage)):
        safe_path(storage, directory).mkdir(mode=PRIVATE_DIR, exist_ok=True)
        make_private(directory)
    path = run_file(storage, run_id, "result.json").parent
    path.mkdir(mode=PRIVATE_DIR)  # FileExistsError if it exists
    make_private(path)
    return path


def _write(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    make_private(path)


def clean_failed_run(
    storage: Storage, run_id: str, *, status: str, stage: str | None, detail: dict[str, Any]
) -> None:
    """
    After a failure, timeout or interruption: removes every file the run wrote (including any
    temporary normalized audio) and leaves a numbers-only `result.json` saying what happened.
    """
    directory = run_file(storage, run_id, "result.json").parent
    if not directory.is_dir():
        return
    for path in directory.iterdir():
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink()
    record = {"format": FORMAT, "runId": run_id, "status": status, "stage": stage, **detail}
    _write(directory / "result.json", json.dumps(record, indent=2))


# --- the episode (read-only) --------------------------------------------------------------------


@dataclass(frozen=True)
class Line:
    id: str
    start_ms: int
    end_ms: int
    text: str

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


@dataclass(frozen=True)
class Episode:
    id: str
    duration_ms: int
    source: Path
    lines: tuple[Line, ...]


def load_episode(storage: Storage, episode_id: str) -> Episode:
    """The episode's stored transcript and source path, through a read-only connection."""
    storage.episode_dir(episode_id)  # validates the id
    if not storage.db_path.is_file():
        raise DiarizeError("No Pebble database in the data directory.")
    conn = sqlite3.connect(f"file:{storage.db_path}?mode=ro", uri=True)
    try:
        row = conn.execute(
            """SELECT e.source_path, t.body FROM episodes e
               JOIN transcripts t ON t.episode_id = e.id WHERE e.id = ?""",
            (episode_id,),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        raise DiarizeError(f"{episode_id}: no completed transcript for this episode.")
    parsed = parse_transcript(json.loads(row[1]))
    if not parsed.ok or parsed.data is None:
        raise DiarizeError(f"{episode_id}: the stored transcript isn't valid.")
    transcript = parsed.data
    if transcript.provenance.kind != "asr":
        raise DiarizeError(f"{episode_id}: only real (ASR) transcripts can be evaluated.")
    source = storage.resolve_relative(row[0])
    if not source.is_file():
        raise DiarizeError(f"{episode_id}: the episode's audio is no longer available.")
    lines = tuple(Line(s.id, s.start_ms, s.end_ms, s.text) for s in transcript.segments)
    return Episode(episode_id, transcript.duration_ms, source, lines)


def _usable_wav(path: Path, duration_ms: int) -> bool:
    try:
        with wave.open(str(path), "rb") as wav:
            shape = (wav.getframerate(), wav.getnchannels(), wav.getsampwidth())
            frames = wav.getnframes()
    except (OSError, EOFError, wave.Error):
        return False
    return shape == (16000, 1, 2) and abs(frames / 16 - duration_ms) <= 500


def _read_samples(path: Path) -> Any:
    import numpy

    with wave.open(str(path), "rb") as wav:
        return numpy.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")


# --- windows, clustering and line labels (pure) --------------------------------------------------


def window_count(duration_ms: int) -> int:
    """How many windows FunASR's `sv_chunk` cuts from one region of this length."""
    if duration_ms <= 0:
        return 0
    if duration_ms <= WINDOW_MS:
        return 1
    return math.ceil((duration_ms - WINDOW_MS) / SHIFT_MS) + 1


def clustering_path(windows: int, hint: int | None) -> str:
    """Which branch of the installed ClusterBackend a run of this size takes."""
    if windows < SINGLE_SPEAKER_BELOW:
        return "single"
    if windows < SPECTRAL_BELOW:
        return "spectral"
    return "kmeans" if hint is not None else "umap-hdbscan"


@dataclass(frozen=True)
class LineLabel:
    speaker: str | None  # "S1", "S2", … in order of first appearance; None: only noise windows
    mixed: bool
    windows: int


def line_labels(window_lines: Sequence[int], labels: Sequence[int], lines: int) -> list[LineLabel]:
    """
    Each line's dominant speaker from its windows' cluster labels (noise excluded), with ties
    going to the label heard first in the line. `mixed` when a second speaker holds at least
    MIXED_MIN_WINDOWS windows and MIXED_MIN_SHARE of the line's labelled windows.
    """
    if len(window_lines) != len(labels):
        raise ValueError("one label per window")
    names: dict[int, str] = {}
    for label in labels:
        if label != NOISE and label not in names:
            names[label] = f"S{len(names) + 1}"
    per_line: list[list[int]] = [[] for _ in range(lines)]
    for line, label in zip(window_lines, labels, strict=True):
        per_line[line].append(label)
    result = []
    for own in per_line:
        votes = [label for label in own if label != NOISE]
        if not votes:
            result.append(LineLabel(None, False, len(own)))
            continue
        counts = Counter(votes)
        ranked = sorted(counts, key=lambda label: (-counts[label], votes.index(label)))
        second = counts[ranked[1]] if len(ranked) > 1 else 0
        mixed = second >= MIXED_MIN_WINDOWS and second / len(votes) >= MIXED_MIN_SHARE
        result.append(LineLabel(names[ranked[0]], mixed, len(own)))
    return result


def cluster_summary(labels: Sequence[int]) -> dict[str, Any]:
    counts = Counter(label for label in labels if label != NOISE)
    total = sum(counts.values())
    shares = sorted((count / total for count in counts.values()), reverse=True) if total else []
    return {
        "speakers": len(counts),
        "noiseWindows": sum(1 for label in labels if label == NOISE),
        "minorClusters": sum(1 for share in shares if share < MINOR_CLUSTER_SHARE),
        "windowShares": [round(share, 4) for share in shares],
    }


def best_mapping(pairs: Sequence[tuple[str, str]]) -> dict[str, str]:
    """
    The one-to-one mapping from predicted to reference labels that agrees on the most pairs.
    Exact (dynamic programming over the smaller side) up to 12 labels on that side, greedy above.
    """
    counts = Counter(pairs)
    predicted = sorted({p for p, _ in pairs})
    reference = sorted({r for _, r in pairs})
    swap = len(reference) > len(predicted)
    rows, cols = (reference, predicted) if swap else (predicted, reference)

    def weight(row: str, col: str) -> int:
        return counts[(col, row)] if swap else counts[(row, col)]

    if len(cols) > 12:
        chosen: dict[str, str] = {}
        for (p, r), _ in counts.most_common():
            if p not in chosen and r not in chosen.values():
                chosen[p] = r
        return chosen
    memo: dict[tuple[int, int], tuple[int, tuple[tuple[int, int], ...]]] = {}

    def solve(i: int, used: int) -> tuple[int, tuple[tuple[int, int], ...]]:
        if i == len(rows):
            return 0, ()
        if (i, used) not in memo:
            best = solve(i + 1, used)
            for j in range(len(cols)):
                if not used & (1 << j) and weight(rows[i], cols[j]):
                    score, rest = solve(i + 1, used | (1 << j))
                    if score + weight(rows[i], cols[j]) > best[0]:
                        best = (score + weight(rows[i], cols[j]), ((i, j), *rest))
            memo[(i, used)] = best
        return memo[(i, used)]

    _, assignment = solve(0, 0)
    if swap:
        return {cols[j]: rows[i] for i, j in assignment}
    return {rows[i]: cols[j] for i, j in assignment}


def agreement(a: Sequence[str | None], b: Sequence[str | None]) -> float | None:
    """Share of lines two labelings agree on, after the best one-to-one mapping."""
    pairs = [(x, y) for x, y in zip(a, b, strict=True) if x is not None and y is not None]
    if not pairs:
        return None
    mapping = best_mapping(pairs)
    return round(sum(mapping.get(x) == y for x, y in pairs) / len(pairs), 4)


# --- review selection and sheet -----------------------------------------------------------------


@dataclass(frozen=True)
class Pick:
    index: int
    stratum: str


STRATUM_ORDER = ("short", "transition", "difficult", "spread")


def line_strata(lines: Sequence[Line], auto: Sequence[LineLabel], difficult: set[int]) -> list[str]:
    """
    Every line's one stratum, first match wins, so the strata partition the episode:

    - `short`: under SHORT_REPLY_MS (by duration alone);
    - `transition`: the auto run's speaker differs from the previous line's;
    - `difficult`: mixed or unassigned in any configuration, or where repeats or the hint
      disagree with auto after mapping;
    - `spread`: everything else.
    """
    strata = []
    for i, line in enumerate(lines):
        if line.duration_ms < SHORT_REPLY_MS:
            strata.append("short")
        elif (
            i > 0
            and auto[i].speaker
            and auto[i - 1].speaker
            and auto[i].speaker != auto[i - 1].speaker
        ):
            strata.append("transition")
        elif i in difficult:
            strata.append("difficult")
        else:
            strata.append("spread")
    return strata


def select_lines(strata: Sequence[str], *, count: int, seed: int) -> list[Pick]:
    """
    A seeded stratified sample: about 20% short, 24% transition and 20% difficult lines drawn at
    random within each stratum, and the rest of the quota from `spread`, one at random per equal
    slice of the episode. A stratum smaller than its quota is taken whole; any shortfall is
    filled at random from the lines not yet chosen. Each pick keeps its own line's stratum, so
    the score can weight every stratum by its real share of the episode.
    """
    rng = random.Random(seed)
    pools = {name: [i for i, s in enumerate(strata) if s == name] for name in STRATUM_ORDER}
    quotas = {name: round(count * share) for name, share in STRATA}
    quotas["spread"] = count - sum(quotas.values())
    chosen: set[int] = set()
    for name, _ in STRATA:
        chosen |= set(rng.sample(pools[name], min(quotas[name], len(pools[name]))))
    spread = pools["spread"]
    slices = min(quotas["spread"], len(spread))
    for b in range(slices):
        chosen.add(rng.choice(spread[len(spread) * b // slices : len(spread) * (b + 1) // slices]))
    leftover = [i for i in range(len(strata)) if i not in chosen]
    chosen |= set(rng.sample(leftover, min(len(leftover), count - len(chosen))))
    return [Pick(i, strata[i]) for i in sorted(chosen)]


def _clock(ms: int) -> str:
    return f"{ms // 60000}:{ms % 60000 / 1000:06.3f}"


def _boxes(options: Sequence[str]) -> str:
    return "  ".join(f"[ ] {option}" for option in options)


def write_review(
    path: Path, *, run_id: str, audio: Path, lines: Sequence[Line], picks: Sequence[Pick]
) -> None:
    """Blind: no predicted speaker, stratum or flag appears in the sheet."""
    out = [
        f"# Speaker review — {run_id}",
        "",
        "Private: this file contains transcript text and local paths. Keep it under ~/.pebble;",
        "never commit, paste or share it.",
        "",
        "Use the same letter for the same voice throughout (A = the first voice you hear, and so",
        "on). `other` is a voice you didn't give a letter. Tick one box per row (`[x]`).",
        "`two or more` means you hear a speaker change inside the line.",
        "",
        "- Speakers in the whole episode (number): ",
        "",
    ]
    for n, pick in enumerate(picks, start=1):
        line = lines[pick.index]
        start, end = line.start_ms, line.end_ms
        lead = max(0, start - 3000)

        def play(at: int, end: int = end) -> str:
            return (
                f"ffplay -nodisp -autoexit -ss {at / 1000:.3f} -t {(end - at) / 1000:.3f} "
                f"{shlex.quote(str(audio))}"
            )

        out += [
            f"### L{n:02d} · {_clock(start)}–{_clock(end)} ({line.duration_ms / 1000:.2f} s) · "
            f"{line.id}",
            "",
            f"- Replay: `{play(start)}`",
            f"- With 3 s before: `{play(lead)}`",
            f"- Text: {line.text}",
            f"- Speaker: {_boxes(SPEAKER_OPTIONS)}",
            f"- Turns: {_boxes(TURN_OPTIONS)}",
            "- Note: ",
            "",
        ]
    _write(path, "\n".join(out))


_ITEM = re.compile(r"^### (L\d{2}) ", re.M)
_TICKED = re.compile(r"\[[xX]\] ([A-Za-z ]+?)(?=\s+\[|\s*$)")
_TOTAL = re.compile(r"^- Speakers in the whole episode \(number\):[ \t]*(\d+)?[ \t]*$", re.M)


def read_review(path: Path) -> dict[str, Any]:
    """Ticks only: `{total, items: {L01: {speaker, turns}}, invalid}`. Never returns text."""
    content = path.read_text(encoding="utf-8")
    total = _TOTAL.search(content)
    parts = _ITEM.split(content)[1:]
    items: dict[str, dict[str, str | None]] = {}
    invalid = 0
    for item, body in zip(parts[0::2], parts[1::2], strict=True):
        answer: dict[str, str | None] = {"speaker": None, "turns": None}
        for row, key, options in (
            ("- Speaker:", "speaker", SPEAKER_OPTIONS),
            ("- Turns:", "turns", TURN_OPTIONS),
        ):
            for text_line in body.splitlines():
                if text_line.startswith(row):
                    ticked = [t.strip() for t in _TICKED.findall(text_line) if t.strip() in options]
                    if len(ticked) == 1:
                        answer[key] = ticked[0]
                    elif ticked:
                        invalid += 1
        items[item] = answer
    return {
        "total": int(total.group(1)) if total and total.group(1) else None,
        "items": items,
        "invalid": invalid,
    }


# --- scoring ------------------------------------------------------------------------------------


def wilson(correct: int, total: int) -> list[float] | None:
    """95% Wilson score interval."""
    if total == 0:
        return None
    z, p = 1.96, correct / total
    centre = (p + z * z / (2 * total)) / (1 + z * z / total)
    half = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / (1 + z * z / total)
    return [round(max(0.0, centre - half), 4), round(min(1.0, centre + half), 4)]


def _accuracy(
    rows: Sequence[tuple[bool, str, int]], keep: Callable[[str, int], bool]
) -> dict[str, Any]:
    kept = [ok for ok, stratum, ms in rows if keep(stratum, ms)]
    correct = sum(kept)
    return {
        "correct": correct,
        "total": len(kept),
        "accuracy": round(correct / len(kept), 4) if kept else None,
        "wilson95": wilson(correct, len(kept)),
    }


def _support(
    stratum: str,
    lines: Sequence[dict[str, Any]],
    reviewed: Sequence[tuple[str, dict[str, Any], dict[str, Any]]],
    config: str,
) -> dict[str, int]:
    """How much evidence one stratum has: its size, what was picked and what was answered."""
    own = [(answer, line) for _, answer, line in reviewed if line["stratum"] == stratum]
    answered = [(a, line) for a, line in own if a["speaker"] not in (None, "unsure")]
    return {
        "inEpisode": sum(line["stratum"] == stratum for line in lines),
        "picked": len(own),
        "speakerAnswered": len(answered),
        "unsureOrBlank": len(own) - len(answered),
        "unassigned": sum(line[config]["speaker"] is None for _, line in answered),
    }


def stratified_estimate(
    rows: Sequence[tuple[bool, str, int]], population: Counter[str]
) -> dict[str, Any]:
    """
    The episode-level accuracy from a stratified sample: each stratum's sample accuracy weighted
    by its share of the episode's lines (`population`, for the same line filter). Strata with no
    reviewed line are left out and the weights renormalized; `populationCovered` says how much of
    the episode that leaves. The 95% interval is a normal approximation with a finite-population
    correction; it is zero-width for a stratum that was all right or all wrong.

    Exploratory: it treats each stratum's reviewed lines as a simple random sample of that
    stratum. `spread` is drawn one per equal slice of its lines in time order (a time-stratified
    draw), so this holds only if accuracy doesn't vary with that slicing; random shortfall fills
    and small strata weaken it further.
    """
    total = sum(population.values())
    estimate = variance = covered = 0.0
    for stratum, size in population.items():
        sample = [ok for ok, s, _ in rows if s == stratum]
        if not sample or not size:
            continue
        n, weight = len(sample), size / total
        p = sum(sample) / n
        estimate += weight * p
        covered += weight
        if n > 1:
            variance += weight * weight * p * (1 - p) / (n - 1) * max(0.0, 1 - n / size)
    if not covered:
        return {
            "status": "exploratory",
            "estimate": None,
            "normal95": None,
            "populationCovered": 0.0,
        }
    estimate, half = estimate / covered, 1.96 * math.sqrt(variance) / covered
    return {
        "status": "exploratory",
        "estimate": round(estimate, 4),
        "normal95": [round(max(0.0, estimate - half), 4), round(min(1.0, estimate + half), 4)],
        "populationCovered": round(covered, 4),
    }


def score(key: dict[str, Any], review: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    picks = key["picks"]
    by_item = {pick["item"]: pick for pick in picks}
    lines = {line["segmentId"]: line for line in key["lines"]}
    configs: dict[str, Any] = {}
    for config in key["configs"]:
        reviewed: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
        for item, answer in review["items"].items():
            pick = by_item.get(item)
            if pick is None:
                continue
            reviewed.append((item, answer, lines[pick["segmentId"]]))
        speaker_pairs = [
            (line[config]["speaker"], answer["speaker"])
            for _, answer, line in reviewed
            if answer["speaker"] not in (None, "unsure") and line[config]["speaker"] is not None
        ]
        mapping = best_mapping(speaker_pairs)
        rows = [
            (
                line[config]["speaker"] is not None
                and mapping.get(line[config]["speaker"]) == answer["speaker"],
                line["stratum"],
                line["endMs"] - line["startMs"],
            )
            for _, answer, line in reviewed
            if answer["speaker"] not in (None, "unsure")
        ]
        flags = Counter(
            (line[config]["mixed"], answer["turns"] == "two or more")
            for _, answer, line in reviewed
            if answer["turns"] in ("one speaker", "two or more")
        )
        tp, fp = flags[(True, True)], flags[(True, False)]
        fn, tn = flags[(False, True)], flags[(False, False)]
        summary = result["configs"][config]
        predicted = summary.get("speakers")

        def population(keep: Callable[[int], bool]) -> Counter[str]:
            return Counter(
                line["stratum"] for line in key["lines"] if keep(line["endMs"] - line["startMs"])
            )

        def long_line(ms: int) -> bool:
            return ms >= LONG_LINE_MS

        configs[config] = {
            "speakerCount": {
                "reviewed": review["total"],
                "predicted": predicted,
                # No whole-episode count from the reviewer means unknown: the comparison is
                # omitted, never guessed.
                "comparison": "omitted: whole-episode count not provided"
                if review["total"] is None
                else "compared",
                "error": None
                if review["total"] is None or predicted is None
                else predicted - review["total"],
                "minorClusters": summary.get("minorClusters"),
            },
            "dominantLine": {
                "episodeEstimate": {
                    "all": stratified_estimate(rows, population(lambda ms: True)),
                    "long": stratified_estimate(
                        [r for r in rows if long_line(r[2])], population(long_line)
                    ),
                    "short": stratified_estimate(
                        [r for r in rows if not long_line(r[2])],
                        population(lambda ms: not long_line(ms)),
                    ),
                },
                "all": _accuracy(rows, lambda s, ms: True),
                "long": _accuracy(rows, lambda s, ms: ms >= LONG_LINE_MS),
                "short": _accuracy(rows, lambda s, ms: ms < LONG_LINE_MS),
                "byStratum": {
                    name: _support(name, key["lines"], reviewed, config)
                    | _accuracy(rows, lambda s, ms, name=name: s == name)
                    for name in STRATUM_ORDER
                },
                # Answered lines the configuration left without a speaker (only noise windows,
                # or none); they count as wrong in every accuracy above.
                "unassigned": sum(
                    1
                    for _, answer, line in reviewed
                    if answer["speaker"] not in (None, "unsure") and line[config]["speaker"] is None
                ),
                "unassignedInEpisode": sum(
                    line[config]["speaker"] is None for line in key["lines"]
                ),
            },
            "mixedFlag": {
                "truePositive": tp,
                "falsePositive": fp,
                "falseNegative": fn,
                "trueNegative": tn,
                "precision": round(tp / (tp + fp), 4) if tp + fp else None,
                "recall": round(tp / (tp + fn), 4) if tp + fn else None,
            },
        }
    repeats_ms = sum(
        c.get("clusteringMs", 0) for n, c in result["configs"].items() if n.startswith("auto-r")
    )
    perf = {
        **result["performance"],
        # processingMs is the primary configuration (audio read, model load, the one embedding
        # pass, auto clustering, and hint clustering when run); repeats are evaluation overhead.
        "primaryProcessingMs": result["performance"]["processingMs"],
        "evaluationOverheadMs": repeats_ms,
        "benchmarkMeasuredMs": result["performance"]["processingMs"] + repeats_ms,
    }

    def long_estimate(config: str) -> float | None:
        dominant = configs.get(config, {}).get("dominantLine", {})
        return dominant.get("episodeEstimate", {}).get("long", {}).get("estimate")

    return {
        "format": FORMAT,
        "runId": result["runId"],
        "reviewed": {
            "items": len(review["items"]),
            "speakerAnswered": sum(
                a["speaker"] not in (None, "unsure") for a in review["items"].values()
            ),
            "turnsAnswered": sum(a["turns"] in TURN_OPTIONS[:2] for a in review["items"].values()),
            "invalidRows": review["invalid"],
        },
        "notes": [
            "dominantLine.episodeEstimate is exploratory: it weights each stratum's accuracy by "
            "its share of the episode and assumes each stratum's reviewed lines are a simple "
            "random sample of it (spread is drawn one per equal slice in time order).",
            "all/long/short are raw sample figures with short, transition and difficult lines "
            "oversampled; the direction of any difference from the episode is not assumed.",
            "byStratum gives each stratum's support: lines in the episode, lines picked, "
            "speaker answers, unsure or blank, and unassigned.",
            "Speaker mapping is fitted one-to-one on the reviewed lines, so every accuracy is "
            "somewhat optimistic on a small sample.",
            "Mixed-flag counts are raw sample counts (mixed lines are oversampled). A flag "
            "estimates more than one turn; it is not verified overlapping speech.",
        ],
        "configs": configs,
        "performance": perf,
        "proposedTargets": {
            "status": "proposed, not established",
            "longLineAccuracy": {
                "target": PROPOSED_TARGETS["longLineAccuracy"],
                "measure": "dominantLine.episodeEstimate.long (exploratory)",
                "auto": long_estimate("auto"),
                "hint": long_estimate("hint"),
            },
            "minutesPerAudioHour": {
                "target": PROPOSED_TARGETS["minutesPerAudioHour"],
                "measured": perf["minutesPerAudioHour"],
            },
            "peakMemoryBytes": {
                "target": PROPOSED_TARGETS["peakMemoryBytes"],
                "measured": perf["peakMemoryBytes"],
            },
        },
    }


# --- the run ------------------------------------------------------------------------------------


def campplus_embedder(storage: Storage) -> Embedder:
    """The pinned CAM++ model from its verified local folder (no hub access, no remote code)."""
    if not verify_model(storage, CAMPPLUS_SV_ZH).passed:
        raise DiarizeError(
            "The speaker model is missing or failed verification. Run: "
            "npm run worker:models -- verify --speaker"
        )
    os.environ.update(hub_environment(storage))
    import numpy
    import torch
    from funasr import AutoModel
    from funasr.models.campplus.utils import extract_feature

    auto = AutoModel(
        model=str(model_dir(storage, CAMPPLUS_SV_ZH)),
        device="cpu",
        disable_update=True,
        check_latest=False,
        disable_pbar=True,
    )
    model = auto.model
    model.eval()

    def embed(windows: list[Any]) -> Any:
        with torch.no_grad():
            feats, _, _ = extract_feature([torch.from_numpy(w) for w in windows])
            return model(feats.to(torch.float32)).cpu().numpy().astype(numpy.float32)

    return embed


def funasr_clusterer(embeddings: Any, hint: int | None, seed: int) -> tuple[list[int], str]:
    """
    FunASR's ClusterBackend as installed, seeded (its k-means and UMAP draw from NumPy's global
    RNG). Its three branches are wrapped to record which one actually ran; none ran means the
    under-SINGLE_SPEAKER_BELOW shortcut.
    """
    import numpy
    from funasr.models.campplus.cluster_backend import ClusterBackend

    numpy.random.seed(seed)
    backend = ClusterBackend(merge_thr=MERGE_THRESHOLD)
    observed: list[str] = []
    for name, attribute in (
        ("spectral", "spectral_cluster"),
        ("umap-hdbscan", "umap_hdbscan_cluster"),
        ("kmeans", "kmeans_cluster"),
    ):
        inner = getattr(backend, attribute)

        def wrapped(*args: Any, _inner: Any = inner, _name: str = name, **kwargs: Any) -> Any:
            observed.append(_name)
            return _inner(*args, **kwargs)

        setattr(backend, attribute, wrapped)
    labels = backend(embeddings, oracle_num=hint)
    return [int(label) for label in labels], (observed[0] if observed else "single")


def _embed_episode(
    samples: Any, lines: Sequence[Line], embed: Embedder, check: Callable[[str], None]
) -> tuple[list[int], Any]:
    """
    The single embedding pass: streams every line's windows through the embedder in batches.
    No window audio is kept; the embeddings exist only in the returned in-memory array.
    """
    import numpy
    from funasr.models.campplus.utils import sv_chunk

    embedded: list[Any] = []
    window_lines: list[int] = []
    pending: list[Any] = []
    pending_lines: list[int] = []

    def flush() -> None:
        if pending:
            check("embedding")
            embedded.append(embed(pending))
            window_lines.extend(pending_lines)
            pending.clear()
            pending_lines.clear()

    for index, line in enumerate(lines):
        first, last = line.start_ms * 16, min(len(samples), line.end_ms * 16)
        if last <= first:
            continue
        region = samples[first:last].astype(numpy.float32) / 32768.0
        for window in sv_chunk([[line.start_ms / 1000, line.end_ms / 1000, region]]):
            pending.append(window[2].astype(numpy.float32))
            pending_lines.append(index)
            if len(pending) >= EMBED_BATCH:
                flush()
    flush()
    matrix = numpy.concatenate(embedded) if embedded else numpy.zeros((0, 192), numpy.float32)
    return window_lines, matrix


def _versions() -> dict[str, str]:
    found = {}
    for package in (
        "funasr",
        "torch",
        "torchaudio",
        "numpy",
        "scikit-learn",
        "scipy",
        "umap-learn",
    ):
        with contextlib.suppress(importlib.metadata.PackageNotFoundError):
            found[package] = importlib.metadata.version(package)
    return found


def plan(episode: Episode, hint: int | None) -> dict[str, Any]:
    """
    Numbers only, without loading a model or reading audio. Window counts here are computed
    from the stored line times with `sv_chunk`'s rule; the run reports the counts it actually
    embedded, and the branch the clusterer actually took.
    """
    windows = sum(window_count(line.duration_ms) for line in episode.lines)
    return {
        "lines": len(episode.lines),
        "durationMs": episode.duration_ms,
        "speechMs": sum(line.duration_ms for line in episode.lines),
        "windowsFromLineTimes": windows,
        "expectedAutoPath": clustering_path(windows, None),
        "expectedHintPath": None if hint is None else clustering_path(windows, hint),
    }


def audio_status(storage: Storage, episode: Episode) -> dict[str, Any]:
    """Whether the run has audio: file presence and the WAV header only, never samples."""
    normalized = storage.work_dir(episode.id) / "normalized.wav"
    return {
        "sourceAvailable": episode.source.is_file(),
        "normalizedWav": "reusable"
        if _usable_wav(normalized, episode.duration_ms)
        else ("unusable" if normalized.exists() else "missing"),
    }


def auto_seeds(seed: int) -> list[int]:
    """Distinct seeds for the auto configuration and its repeats: seed, seed+1, seed+2."""
    return [seed + n for n in range(REPEATS)]


def check_arguments(hint: int | None, lines: int, deadline_minutes: float | None = None) -> None:
    if hint is not None and not 1 <= hint <= MAX_SPEAKERS:
        raise DiarizeError(f"The speaker count hint must be between 1 and {MAX_SPEAKERS}.")
    if not MIN_LINES <= lines <= MAX_LINES:
        raise DiarizeError(f"Review between {MIN_LINES} and {MAX_LINES} lines.")
    if deadline_minutes is not None and not (
        MIN_DEADLINE_MINUTES <= deadline_minutes <= MAX_DEADLINE_MINUTES
    ):
        raise DiarizeError(
            f"The deadline must be between {MIN_DEADLINE_MINUTES} and {MAX_DEADLINE_MINUTES} "
            "minutes."
        )


def run(
    storage: Storage,
    settings: Settings,
    episode_id: str,
    *,
    hint: int | None,
    lines: int,
    seed: int,
    run_id: str | None = None,
    deadline_at: float | None = None,
    embedder: Callable[[Storage], Embedder] = campplus_embedder,
    clusterer: Clusterer = funasr_clusterer,
    now: datetime | None = None,
) -> Path:
    """
    One evaluation run, in this process. `deadline_at` (wall-clock seconds) is checked between
    steps, between embedding batches and between clustering configurations. On any failure,
    timeout or interruption every file the run wrote is removed and a status-only `result.json`
    is left (`clean_failed_run`). With `run_id`, the folder was created by `run_bounded`.
    """
    check_arguments(hint, lines)
    episode = load_episode(storage, episode_id)
    if run_id is None:
        run_id = new_run_id(episode_id, now)
        directory = create_run_dir(storage, run_id)
    else:
        directory = run_file(storage, run_id, "result.json").parent
        if not directory.is_dir() or any(directory.iterdir()):
            raise DiarizeError(f"{run_id}: the run folder must exist and be empty.")
    timings: dict[str, int] = {}
    stage = "starting"

    def check(next_stage: str) -> None:
        nonlocal stage
        stage = next_stage
        if deadline_at is not None and time.time() >= deadline_at:
            raise DeadlineExceeded(next_stage)

    def timed(name: str, work: Callable[[], Any]) -> Any:
        started = time.perf_counter()
        value = work()
        timings[name] = round((time.perf_counter() - started) * 1000)
        return value

    try:
        return _run(
            storage, settings, episode, run_id, directory,
            hint=hint, lines=lines, seed=seed, deadline_at=deadline_at,
            embedder=embedder, clusterer=clusterer, now=now,
            check=check, timed=timed, timings=timings,
        )  # fmt: skip
    except BaseException as error:
        status = (
            "timed_out"
            if isinstance(error, DeadlineExceeded)
            else "interrupted"
            if isinstance(error, KeyboardInterrupt)
            else "failed"
        )
        clean_failed_run(
            storage,
            run_id,
            status=status,
            stage=stage,
            detail={"error": type(error).__name__, "timingsMs": timings},
        )
        raise


def _run(
    storage: Storage,
    settings: Settings,
    episode: Episode,
    run_id: str,
    directory: Path,
    *,
    hint: int | None,
    lines: int,
    seed: int,
    deadline_at: float | None,
    embedder: Callable[[Storage], Embedder],
    clusterer: Clusterer,
    now: datetime | None,
    check: Callable[[str], None],
    timed: Callable[[str, Callable[[], Any]], Any],
    timings: dict[str, int],
) -> Path:
    sampler = MemorySampler().start()
    check("audio")
    audio = storage.work_dir(episode.id) / "normalized.wav"
    reused = _usable_wav(audio, episode.duration_ms)
    if not reused:
        # Temporary: read once, then deleted before embedding starts.
        audio = directory / "normalized.wav"
        timed("normalizeMs", lambda: normalize(episode.source, audio, ffmpeg=settings.ffmpeg_path))
        make_private(audio)
    samples = timed("audioReadMs", lambda: _read_samples(audio))
    if not reused:
        audio.unlink()
    check("model load")
    embed = timed("modelLoadMs", lambda: embedder(storage))
    started = time.perf_counter()
    window_lines, embeddings = _embed_episode(samples, episode.lines, embed, check)
    timings["embeddingMs"] = round((time.perf_counter() - started) * 1000)
    del samples, embed

    configs: dict[str, Any] = {}
    labelings: dict[str, list[LineLabel]] = {}
    runs: list[tuple[str, int | None, int]] = [
        (name, None, config_seed)
        for name, config_seed in zip(("auto", "auto-r2", "auto-r3"), auto_seeds(seed), strict=True)
    ]
    if hint is not None:
        runs.append(("hint", hint, seed))
    expected = {k: clustering_path(len(window_lines), k) for k in (None, hint)}
    for name, k, config_seed in runs:
        check(f"clustering {name}")
        started = time.perf_counter()
        try:
            # Every configuration clusters a fresh copy of the one embedding pass.
            labels, observed = clusterer(embeddings.copy(), k, config_seed)
        except Exception as error:  # a clusterer failure is a result, not a crash
            configs[name] = {"failure": type(error).__name__, "seed": config_seed, "hint": k}
            continue
        elapsed = round((time.perf_counter() - started) * 1000)
        labelings[name] = line_labels(window_lines, labels, len(episode.lines))
        configs[name] = {
            "seed": config_seed,
            "hint": k,
            "windows": len(labels),
            "path": observed,
            "expectedPath": expected[k],
            "clusteringMs": elapsed,
            **cluster_summary(labels),
            "mixedLines": sum(label.mixed for label in labelings[name]),
            "unassignedLines": sum(label.speaker is None for label in labelings[name]),
        }
    windows = len(window_lines)
    del embeddings, window_lines  # never written anywhere
    memory = sampler.stop()
    if "auto" not in labelings:
        raise DiarizeError("Automatic clustering failed.")

    check("writing")
    auto = labelings["auto"]
    difficult = {
        i
        for labeling in labelings.values()
        for i, label in enumerate(labeling)
        if label.mixed or label.speaker is None
    }
    for name, other in labelings.items():
        if name == "auto":
            continue
        speakers = [x.speaker for x in auto], [x.speaker for x in other]
        mapping = best_mapping([(a, b) for a, b in zip(*speakers, strict=True) if a and b])
        difficult |= {
            i
            for i, (a, b) in enumerate(zip(*speakers, strict=True))
            if a and b and mapping.get(a) != b
        }
        configs[name]["agreementWithAuto"] = agreement(*speakers)
    strata = line_strata(episode.lines, auto, difficult)
    picks = select_lines(strata, count=lines, seed=seed)

    processing_ms = sum(timings.values()) + sum(
        c.get("clusteringMs", 0) for n, c in configs.items() if n in ("auto", "hint")
    )
    peak = memory.phys_footprint_job_peak_bytes or memory.rss_max_bytes
    population = Counter(strata)
    result = {
        "format": FORMAT,
        "runId": run_id,
        "status": "completed",
        "createdAt": (now or datetime.now(UTC)).isoformat(timespec="seconds"),
        "episode": {"id": episode.id, **plan(episode, hint)},
        "model": {
            "id": CAMPPLUS_SV_ZH.model_id,
            "revision": CAMPPLUS_SV_ZH.revision,
            "license": CAMPPLUS_SV_ZH.license,
        },
        "runtime": {**_versions(), "device": "cpu"},
        "settings": {
            "windowMs": WINDOW_MS,
            "shiftMs": SHIFT_MS,
            "mergeThreshold": MERGE_THRESHOLD,
            "singleSpeakerBelow": SINGLE_SPEAKER_BELOW,
            "spectralBelow": SPECTRAL_BELOW,
            "mixedMinWindows": MIXED_MIN_WINDOWS,
            "mixedMinShare": MIXED_MIN_SHARE,
            "longLineMs": LONG_LINE_MS,
            "seed": seed,
            "autoSeeds": auto_seeds(seed),
            "hintSeed": seed if hint is not None else None,
            "hint": hint,
            "reviewLines": lines,
            "deadlineAt": deadline_at,
        },
        "windows": windows,
        "embeddingPasses": 1,
        "audio": "reused" if reused else "normalized-temporarily",
        "timingsMs": timings,
        "memory": memory.as_dict(),
        "configs": configs,
        "strata": {name: population[name] for name in STRATUM_ORDER},
        "selection": {name: sum(p.stratum == name for p in picks) for name in STRATUM_ORDER},
        "performance": {
            "processingMs": processing_ms,
            "minutesPerAudioHour": round(
                processing_ms / 60000 / (episode.duration_ms / 3_600_000), 2
            )
            if episode.duration_ms
            else None,
            "peakMemoryBytes": peak,
        },
        "networkAttempts": network.attempts(),
    }
    key = {
        "format": FORMAT,
        "runId": run_id,
        "configs": sorted(labelings.keys() & {"auto", "hint"}),
        "strata": result["strata"],
        "lines": [
            {
                "segmentId": line.id,
                "startMs": line.start_ms,
                "endMs": line.end_ms,
                "stratum": strata[i],
                **{
                    name: {
                        "speaker": lab[i].speaker,
                        "mixed": lab[i].mixed,
                        "windows": lab[i].windows,
                    }
                    for name, lab in labelings.items()
                },
            }
            for i, line in enumerate(episode.lines)
        ],
        "picks": [
            {"item": f"L{n:02d}", "segmentId": episode.lines[p.index].id, "stratum": p.stratum}
            for n, p in enumerate(picks, start=1)
        ],
    }
    # Replays use the episode's own audio: its normalized copy when reused, else the source.
    replay = storage.work_dir(episode.id) / "normalized.wav" if reused else episode.source
    write_review(
        directory / "review.md", run_id=run_id, audio=replay, lines=episode.lines, picks=picks
    )
    _write(directory / "key.json", json.dumps(key, indent=2))
    _write(directory / "result.json", json.dumps(result, indent=2))
    return directory


def run_bounded(
    storage: Storage,
    settings: Settings,
    episode_id: str,
    *,
    hint: int | None,
    lines: int,
    seed: int,
    deadline_minutes: float = DEFAULT_DEADLINE_MINUTES,
    command: Sequence[str] | None = None,
    grace_seconds: float = KILL_GRACE_SECONDS,
    now: datetime | None = None,
) -> Path:
    """
    Runs `run` in a child process with a hard limit. The child stops itself at the deadline
    (between batches and configurations) and cleans up; if it is still running
    `grace_seconds` later, or this process is interrupted, the child is killed and this process
    cleans up instead. Embeddings live only in the child's memory, so they go with it.
    """
    check_arguments(hint, lines, deadline_minutes)
    load_episode(storage, episode_id)  # refuse early, read-only
    run_id = new_run_id(episode_id, now)
    create_run_dir(storage, run_id)
    deadline_at = time.time() + deadline_minutes * 60
    spec = {
        "episode": episode_id,
        "hint": hint,
        "lines": lines,
        "seed": seed,
        "runId": run_id,
        "deadlineAt": deadline_at,
    }
    argv = list(command or [sys.executable, "-m", "pebble_worker.bench.diarize_child"])
    numba_cache = run_file(storage, run_id, "result.json").parent / NUMBA_CACHE_DIRNAME
    env = {
        **os.environ,
        "PEBBLE_DATA_DIR": str(settings.data_dir),
        "NUMBA_CACHE_DIR": str(numba_cache),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    started = time.time()
    try:
        # FunASR's own console output may name local paths; it is captured and dropped.
        completed = subprocess.run(
            [*argv, json.dumps(spec)],
            env=env,
            capture_output=True,
            text=True,
            timeout=max(0.0, deadline_at - time.time()) + grace_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired:
        clean_failed_run(
            storage,
            run_id,
            status="killed_at_deadline",
            stage=None,
            detail={"elapsedSeconds": round(time.time() - started)},
        )
        raise DiarizeError(
            f"{run_id}: stopped at its deadline and killed; partial files were removed."
        ) from None
    except KeyboardInterrupt:
        clean_failed_run(storage, run_id, status="interrupted", stage=None, detail={})
        raise
    finally:
        shutil.rmtree(numba_cache, ignore_errors=True)
    record_path = run_file(storage, run_id, "result.json")
    record = json.loads(record_path.read_text(encoding="utf-8")) if record_path.is_file() else {}
    if completed.returncode != 0 or record.get("status") != "completed":
        if record.get("status") in (None, "completed"):
            clean_failed_run(
                storage,
                run_id,
                status="failed",
                stage=None,
                detail={"exitCode": completed.returncode},
            )
            record = {"status": "failed"}
        raise DiarizeError(
            f"{run_id}: the run {record['status'].replace('_', ' ')}; see result.json."
        )
    return record_path.parent


def score_run(storage: Storage, run_id: str) -> dict[str, Any]:
    paths = {
        name: run_file(storage, run_id, name) for name in ("result.json", "key.json", "review.md")
    }
    missing = [name for name, path in paths.items() if not path.is_file()]
    if missing:
        raise DiarizeError(f"{run_id}: missing {', '.join(missing)}.")
    scored = score(
        json.loads(paths["key.json"].read_text(encoding="utf-8")),
        read_review(paths["review.md"]),
        json.loads(paths["result.json"].read_text(encoding="utf-8")),
    )
    _write(run_file(storage, run_id, "score.json"), json.dumps(scored, indent=2))
    return scored


# --- targeted diagnostic review of unmatched clusters --------------------------------------------
#
# After the main review: the clusters it left without a reviewer voice (the one-to-one matching had
# more clusters than letters) get a short blind sheet of not-yet-reviewed lines, to hear whether
# they are the existing A/B voices or another voice. Built only from key.json and the main review's
# ticks: no database, transcript text or audio samples. Diagnostic, never an accuracy estimate.

TARGETED_PER_CLUSTER = 5
TARGETED_OPTIONS = ("A", "B", "another voice", "unsure")
_TARGETED_ITEM = re.compile(r"^### (T\d{2}) ", re.M)


def unmatched_clusters(
    key: dict[str, Any], review: dict[str, Any], config: str = "auto"
) -> list[str]:
    """Clusters the main review's one-to-one matching didn't pair with a reviewer letter."""
    lines = {line["segmentId"]: line for line in key["lines"]}
    picks = {pick["item"]: pick for pick in key["picks"]}
    pairs = [
        (lines[picks[item]["segmentId"]][config]["speaker"], answer["speaker"])
        for item, answer in review["items"].items()
        if item in picks
        and answer["speaker"] not in (None, "unsure")
        and lines[picks[item]["segmentId"]][config]["speaker"] is not None
    ]
    matched = best_mapping(pairs)
    clusters = {line[config]["speaker"] for line in key["lines"] if line[config]["speaker"]}
    return sorted((c for c in clusters if c not in matched), key=lambda c: int(c[1:]))


def select_targeted(
    key: dict[str, Any],
    clusters: Sequence[str],
    *,
    per_cluster: int = TARGETED_PER_CLUSTER,
    seed: int = 7,
    config: str = "auto",
) -> list[tuple[int, str]]:
    """
    Up to `per_cluster` lines per cluster that the main review didn't include, one at random per
    equal slice of the cluster's remaining lines in time order (all of them if there are fewer).
    """
    reviewed = {pick["segmentId"] for pick in key["picks"]}
    rng = random.Random(seed)
    chosen: list[tuple[int, str]] = []
    for cluster in clusters:
        pool = [
            i
            for i, line in enumerate(key["lines"])
            if line[config]["speaker"] == cluster and line["segmentId"] not in reviewed
        ]
        slices = min(per_cluster, len(pool))
        for b in range(slices):
            part = pool[len(pool) * b // slices : len(pool) * (b + 1) // slices]
            chosen.append((rng.choice(part), cluster))
    return sorted(chosen)


def prepare_targeted(storage: Storage, run_id: str, *, seed: int = 7) -> dict[str, Any]:
    """Writes targeted-review.md (blind) and targeted-key.json; returns counts only."""
    paths = {n: run_file(storage, run_id, n) for n in ("result.json", "key.json", "review.md")}
    if not all(path.is_file() for path in paths.values()):
        raise DiarizeError(f"{run_id}: the main review must exist first.")
    sheet, key_path = (
        run_file(storage, run_id, n) for n in ("targeted-review.md", "targeted-key.json")
    )
    if sheet.exists() or key_path.exists():
        raise DiarizeError(f"{run_id}: a targeted review already exists; it is never overwritten.")
    result = json.loads(paths["result.json"].read_text(encoding="utf-8"))
    key = json.loads(paths["key.json"].read_text(encoding="utf-8"))
    clusters = unmatched_clusters(key, read_review(paths["review.md"]))
    if not clusters:
        raise DiarizeError(f"{run_id}: every cluster was matched; there is nothing to target.")
    audio = storage.work_dir(result["episode"]["id"]) / "normalized.wav"
    if not audio.is_file():
        raise DiarizeError(f"{run_id}: the episode's normalized audio is gone; replays won't work.")
    chosen = select_targeted(key, clusters, seed=seed)
    out = [
        f"# Targeted speaker check — {run_id}",
        "",
        "Private: this file contains local paths. Keep it under ~/.pebble; never commit or",
        "share it.",
        "",
        "A and B are the same two voices you labelled in review.md. For each line, replay it and",
        "tick one box (`[x]`): `A`, `B`, `another voice` (neither A nor B), or `unsure`.",
        "These lines are a diagnostic check, not a representative sample of the episode.",
        "",
    ]
    for n, (index, _) in enumerate(chosen, start=1):
        line = key["lines"][index]
        start, end = line["startMs"], line["endMs"]
        lead = max(0, start - 3000)

        def play(at: int, end: int = end) -> str:
            return (
                f"ffplay -nodisp -autoexit -ss {at / 1000:.3f} -t {(end - at) / 1000:.3f} "
                f"{shlex.quote(str(audio))}"
            )

        out += [
            f"### T{n:02d} · {_clock(start)}–{_clock(end)} ({(end - start) / 1000:.2f} s) · "
            f"{line['segmentId']}",
            "",
            f"- Replay: `{play(start)}`",
            f"- With 3 s before: `{play(lead)}`",
            f"- Voice: {_boxes(TARGETED_OPTIONS)}",
            "- Note: ",
            "",
        ]
    _write(sheet, "\n".join(out))
    targeted_key = {
        "format": FORMAT,
        "runId": run_id,
        "config": "auto",
        "clusters": clusters,
        "seed": seed,
        "items": [
            {
                "item": f"T{n:02d}",
                "segmentId": key["lines"][index]["segmentId"],
                "cluster": cluster,
                "startMs": key["lines"][index]["startMs"],
                "endMs": key["lines"][index]["endMs"],
            }
            for n, (index, cluster) in enumerate(chosen, start=1)
        ],
    }
    _write(key_path, json.dumps(targeted_key, indent=2))
    return {
        "clusters": len(clusters),
        "items": len(chosen),
        "perCluster": dict(Counter(cluster for _, cluster in chosen)),
    }


def read_targeted(path: Path) -> dict[str, Any]:
    """Ticks only: `{items: {T01: answer | None}, invalid}`. Never returns text."""
    parts = _TARGETED_ITEM.split(path.read_text(encoding="utf-8"))[1:]
    items: dict[str, str | None] = {}
    invalid = 0
    for item, body in zip(parts[0::2], parts[1::2], strict=True):
        items[item] = None
        for row in body.splitlines():
            if row.startswith("- Voice:"):
                ticked = [t.strip() for t in _TICKED.findall(row) if t.strip() in TARGETED_OPTIONS]
                if len(ticked) == 1:
                    items[item] = ticked[0]
                elif ticked:
                    invalid += 1
    return {"items": items, "invalid": invalid}


def score_targeted(storage: Storage, run_id: str) -> dict[str, Any]:
    """Per unmatched cluster: how its sampled lines sounded. Diagnostic only."""
    key_path, sheet = (
        run_file(storage, run_id, n) for n in ("targeted-key.json", "targeted-review.md")
    )
    if not key_path.is_file() or not sheet.is_file():
        raise DiarizeError(f"{run_id}: no targeted review to score.")
    key = json.loads(key_path.read_text(encoding="utf-8"))
    answers = read_targeted(sheet)
    clusters: dict[str, dict[str, int]] = {
        cluster: {**dict.fromkeys(TARGETED_OPTIONS, 0), "blank": 0} for cluster in key["clusters"]
    }
    for entry in key["items"]:
        answer = answers["items"].get(entry["item"])
        clusters[entry["cluster"]][answer or "blank"] += 1
    scored = {
        "format": FORMAT,
        "runId": run_id,
        "kind": "targeted diagnostic; not a representative accuracy estimate",
        "invalidRows": answers["invalid"],
        "clusters": clusters,
    }
    _write(run_file(storage, run_id, "targeted-score.json"), json.dumps(scored, indent=2))
    return scored
