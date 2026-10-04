"""
One benchmark run: the real pipeline stages (probe → normalize → chunk → FunASR → merge),
in-process, timed stage by stage, with setup (verification, import, model load) measured
separately so first-run and later-run waiting can be described honestly.
"""

from __future__ import annotations

import importlib
import json
import shutil
import subprocess
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from .. import __version__
from ..config import ChunkingConfig, Settings
from ..errors import FailureCode, PipelineError
from ..pipeline.chunk import detect_silences, plan_chunks, write_chunks
from ..pipeline.merge import ChunkResult, merge
from ..pipeline.normalize import normalize
from ..pipeline.probe import probe
from ..providers.base import AudioChunk, RawSegment
from ..providers.funasr import FunASRProvider
from ..storage import PRIVATE_DIR, Storage, make_private
from . import analysis, network
from .corpus import Clip
from .memory import MemorySampler
from .results import RESULT_SCHEMA_VERSION, RunResult
from .review import write_review

Mode = Literal["warm", "cold"]
#: Chunk min/max for a target, as the ratios of the current 150/120/240 s default.
MIN_RATIO, MAX_RATIO = 0.8, 1.6
SYNTHETIC_VOICE = "Tingting"
#: Invented sentences for the synthetic sanity check; not from any recording.
SYNTHETIC_SCRIPT = (
    "今天早上我去市场买了一些新鲜的水果和蔬菜。",
    "然后我在公园里散步，天气很好，风也很舒服。",
    "中午我和朋友一起吃饭，我们聊了很多工作上的事情。",
    "下午我在家里看书，还学了一会儿中文。",
    "晚上我给家里打电话，问他们最近过得怎么样。",
    "周末我们打算去山上走走，顺便拍一些照片。",
    "如果下雨的话，我们就在家里做饭，看一部电影。",
    "我觉得每天坚持听一点中文，对学习很有帮助。",
)


@dataclass(frozen=True)
class Setup:
    scope: Literal["this-run", "shared-warm-session"]
    process_startup_ms: int | None
    verification_ms: int
    import_ms: int
    load_ms: int


@dataclass(frozen=True)
class BenchInput:
    clip_id: str
    label: str
    kind: Literal["corpus", "synthetic"]
    source: Path | None  # None: synthesized into the run directory
    reference_text: str | None
    reference_label: str | None


def corpus_input(clip: Clip) -> BenchInput:
    reference = clip.reference_path.read_text(encoding="utf-8") if clip.reference_path else None
    return BenchInput(
        clip.id,
        clip.label,
        "corpus",
        clip.path,
        reference,
        f"{clip.label} reference" if reference else None,
    )


def synthetic_input() -> BenchInput:
    return BenchInput(
        "synthetic",
        "Synthetic speech",
        "synthetic",
        None,
        "".join(SYNTHETIC_SCRIPT),
        "synthetic script",
    )


def chunking_for(target_seconds: int | None, settings: Settings) -> ChunkingConfig:
    """`None` is the worker's current default; a target gets min/max at the default's ratios."""
    if target_seconds is None:
        return settings.chunking
    base = settings.chunking
    return ChunkingConfig(
        target_seconds=target_seconds,
        min_seconds=round(target_seconds * MIN_RATIO),
        max_seconds=round(target_seconds * MAX_RATIO),
        silence_min_seconds=base.silence_min_seconds,
        silence_noise_db=base.silence_noise_db,
    )


def measure_setup(
    provider: FunASRProvider,
    *,
    import_runtime: Callable[[], object],
    scope: Literal["this-run", "shared-warm-session"],
    process_startup_ms: int | None = None,
) -> Setup:
    started = time.perf_counter()
    provider.prepare(wait=True)
    verified = time.perf_counter()
    import_runtime()
    imported = time.perf_counter()
    provider.load()
    loaded = time.perf_counter()
    return Setup(
        scope,
        process_startup_ms,
        _ms(verified - started),
        _ms(imported - verified),
        _ms(loaded - imported),
    )


def real_import() -> object:
    return importlib.import_module("funasr")


def run_one(
    storage: Storage,
    settings: Settings,
    bench_input: BenchInput,
    *,
    target_seconds: int | None,
    mode: Mode,
    provider: FunASRProvider,
    setup: Setup,
    seed: int,
    now: datetime | None = None,
) -> Path:
    from .paths import create_run_dir

    now = now or datetime.now(UTC)
    chunking = chunking_for(target_seconds, settings)
    run_id = f"{now:%Y%m%dT%H%M%SZ}-{bench_input.clip_id}-{round(chunking.target_seconds)}s-{mode}"
    directory = create_run_dir(storage, run_id)
    work = directory / "work"
    work.mkdir(mode=PRIVATE_DIR)
    source = bench_input.source or synthesize(directory / "source.aiff")
    normalized = directory / "normalized.wav"

    timings: dict[str, int] = {}
    sampler = MemorySampler().start()
    stage = "probing"
    status, failure = "completed", None
    plans, transcript = [], None
    started = time.perf_counter()
    try:
        mark = time.perf_counter()
        probe(source, ffprobe=settings.ffprobe_path, max_seconds=settings.max_audio_seconds)
        timings["probeMs"], mark = _ms(time.perf_counter() - mark), time.perf_counter()
        stage = "normalizing"
        duration_ms = normalize(source, normalized, ffmpeg=settings.ffmpeg_path)
        timings["normalizeMs"], mark = _ms(time.perf_counter() - mark), time.perf_counter()
        stage = "chunking"
        silences = detect_silences(normalized, duration_ms, chunking, ffmpeg=settings.ffmpeg_path)
        plans = plan_chunks(duration_ms, silences, chunking)
        (work / "chunks").mkdir(mode=PRIVATE_DIR)
        paths = write_chunks(normalized, plans, work / "chunks")
        timings["chunkingMs"], mark = _ms(time.perf_counter() - mark), time.perf_counter()
        stage = "transcribing"
        results: list[ChunkResult] = []
        for plan, path in zip(plans, paths, strict=True):
            segments: list[RawSegment] = provider.transcribe(
                AudioChunk(plan.index, plan.start_ms, plan.end_ms, path), lambda: False
            )
            results.append(ChunkResult(plan.start_ms, segments, index=plan.index))
        timings["transcriptionMs"], mark = _ms(time.perf_counter() - mark), time.perf_counter()
        stage = "merging"
        transcript = merge(
            episode_id="ep-000000000000",
            duration_ms=duration_ms,
            language="zh-CN",
            chunks=results,
            provider=provider,
            review=settings.review,
        )
        timings["mergeMs"] = _ms(time.perf_counter() - mark)
        if not transcript.segments:
            status = "no-speech"
    except PipelineError as error:
        status, failure = "failed", {"stage": stage, "code": error.code.value}
    finally:
        total_ms = _ms(time.perf_counter() - started)
        memory = sampler.stop()
        shutil.rmtree(work, ignore_errors=True)

    duration_ms_known = transcript.duration_ms if transcript else None
    result: dict[str, object] = {
        "schemaVersion": RESULT_SCHEMA_VERSION,
        "runId": run_id,
        "createdAt": now.isoformat().replace("+00:00", "Z"),
        "workerVersion": __version__,
        "status": status,
        "failure": failure,
        "clip": {
            "id": bench_input.clip_id,
            "label": bench_input.label,
            "kind": bench_input.kind,
            "durationMs": duration_ms_known,
        },
        "mode": mode,
        "chunking": {
            "targetSeconds": chunking.target_seconds,
            "minSeconds": chunking.min_seconds,
            "maxSeconds": chunking.max_seconds,
            "silenceMinSeconds": chunking.silence_min_seconds,
            "silenceNoiseDb": chunking.silence_noise_db,
            "isWorkerDefault": target_seconds is None,
        },
        "provider": _provider_info(provider),
        "setup": {
            "scope": setup.scope,
            "processStartupMs": setup.process_startup_ms,
            "verificationMs": setup.verification_ms,
            "importMs": setup.import_ms,
            "loadMs": setup.load_ms,
        },
        "job": {
            **{key: timings.get(key) for key in _STAGE_KEYS},
            "totalMs": total_ms,
            "realTimeFactor": (
                round(total_ms / duration_ms_known, 4)
                if duration_ms_known and status != "failed"
                else None
            ),
        },
        "memory": memory.as_dict(),
        "chunks": analysis.chunk_shape(plans),
        "segments": analysis.segment_shape(transcript) if transcript else None,
        "merge": analysis.merge_checks(transcript) if transcript else None,
        "boundaries": None,
        "cer": None,
        "review": None,
        "network": {"attempts": network.attempts()},
    }
    if transcript is not None:
        rows = analysis.boundary_analysis(plans, transcript)
        result["boundaries"] = {"summary": analysis.boundary_summary(rows), "cuts": rows}
        if bench_input.reference_text is not None:
            value = analysis.character_error_rate(
                "".join(s.text for s in transcript.segments), bench_input.reference_text
            )
            result["cer"] = {
                "value": value,
                "kind": "synthetic-sanity" if bench_input.kind == "synthetic" else "reference",
                "referenceLabel": bench_input.reference_label,
            }
        picks = analysis.select_for_review(plans, transcript, seed=seed)
        result["review"] = {"segments": len(picks), "seed": seed}
        _write_private(
            directory / "transcript.json",
            json.dumps(transcript.dump(), ensure_ascii=False, indent=2),
        )
        write_review(
            directory / "review.md",
            label=bench_input.label,
            run_id=run_id,
            audio=normalized,
            picks=picks,
        )
        make_private(directory / "review.md")
    validated = RunResult.model_validate(result)
    _write_private(directory / "result.json", json.dumps(validated.dump(), indent=2))
    for path in directory.iterdir():
        make_private(path)
    return directory


_STAGE_KEYS = ("probeMs", "normalizeMs", "chunkingMs", "transcriptionMs", "mergeMs")


def synthesize(target: Path) -> Path:
    """Invented Mandarin sentences, spoken by macOS `say` (opt-in sanity check only)."""
    if sys.platform != "darwin" or shutil.which("say") is None:
        raise PipelineError(
            FailureCode.UNSUPPORTED_MEDIA, "Synthetic speech needs macOS `say`.", retryable=False
        )
    subprocess.run(
        ["say", "-v", SYNTHETIC_VOICE, "-o", str(target), "".join(SYNTHETIC_SCRIPT)], check=True
    )
    make_private(target)
    return target


def _provider_info(provider: FunASRProvider) -> dict[str, object]:
    details = provider.provenance_details()
    return {
        "id": provider.id,
        "models": [{"role": m.role, "id": m.id, "revision": m.revision} for m in details.models],
        "runtime": details.runtime,
    }


def _write_private(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    make_private(path)


def _ms(seconds: float) -> int:
    return round(seconds * 1000)


# --- cold runs: a fresh process per run ----------------------------------------------------------


def run_cold(
    storage: Storage, clip_id: str, target_seconds: int | None, seed: int, env: dict[str, str]
) -> Path:
    """Spawns `python -m pebble_worker.bench.child`; it is told only the clip id, never a path."""
    spec = {
        "clip": clip_id,
        "target": target_seconds,
        "seed": seed,
        "spawnedAt": time.time(),
    }
    completed = subprocess.run(
        [sys.executable, "-m", "pebble_worker.bench.child", json.dumps(spec)],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    lines = [line for line in completed.stdout.splitlines() if line.startswith("{")]
    if completed.returncode != 0 or not lines:
        raise RuntimeError(f"Cold benchmark process failed (exit {completed.returncode}).")
    from .paths import run_dir

    return run_dir(storage, json.loads(lines[-1])["runId"])


def warm_session(
    storage: Storage,
    settings: Settings,
    bench_input: BenchInput,
    targets: Sequence[int | None],
    *,
    provider: FunASRProvider,
    import_runtime: Callable[[], object] = real_import,
    seed: int,
) -> list[Path]:
    """Sets up once (reported as a shared warm-session setup), then runs each target."""
    setup = measure_setup(provider, import_runtime=import_runtime, scope="shared-warm-session")
    return [
        run_one(
            storage,
            settings,
            bench_input,
            target_seconds=target,
            mode="warm",
            provider=provider,
            setup=setup,
            seed=seed,
        )
        for target in targets
    ]
