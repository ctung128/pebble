"""Shared fixtures. All test audio is generated with ffmpeg; no binary fixtures are committed."""

from __future__ import annotations

import subprocess
import time
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pebble_worker.api import create_app
from pebble_worker.config import ChunkingConfig, Settings

REPO = Path(__file__).resolve().parents[3]
EXAMPLES = REPO / "packages" / "schema" / "examples"
DEMO_AUDIO = REPO / "fixtures" / "demo" / "demo-001" / "audio.m4a"
WORKER_URL = "http://127.0.0.1:8790"
#: Small chunk sizes so tests exercise several chunks on a few seconds of audio.
TEST_CHUNKING = ChunkingConfig(
    target_seconds=3, min_seconds=2, max_seconds=4, silence_min_seconds=0.3
)


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", *args], check=True)


@pytest.fixture(scope="session")
def audio(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    """
    tone_gaps.m4a   14 s: 2.0 s of tone then 0.5 s of silence, repeating
                    → silences centred on 2.25, 4.75, 7.25, 9.75, 12.25 s
    tone.m4a        10 s of continuous tone (no usable silence → hard cuts)
    short.wav       1.5 s tone (single chunk)
    video_only.mp4  video with no audio stream
    not_audio.mp3   text bytes with an audio extension
    """
    root = tmp_path_factory.mktemp("audio")
    gaps = r"if(lt(mod(t\,2.5)\,2)\,0.5*sin(2*PI*440*t)\,0)"
    ffmpeg(
        "-f",
        "lavfi",
        "-i",
        f"aevalsrc=exprs={gaps}:s=16000:d=14",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        str(root / "tone_gaps.m4a"),
    )
    ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=16000:duration=10",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        str(root / "tone.m4a"),
    )
    ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=16000:duration=1.5",
        str(root / "short.wav"),
    )
    ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=1:size=64x64:rate=5",
        "-c:v",
        "mpeg4",
        str(root / "video_only.mp4"),
    )
    (root / "not_audio.mp3").write_text("this is not audio")
    return {path.stem: path for path in root.iterdir()}


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(data_dir=tmp_path / "pebble", chunking=TEST_CHUNKING, mock_delay_ms=0)


@pytest.fixture
def make_client(settings: Settings) -> Iterator[Callable[..., TestClient]]:
    clients: list[TestClient] = []

    def factory(*, start_runner: bool = True, **kwargs: object) -> TestClient:
        app = create_app(kwargs.pop("settings", settings), start_runner=start_runner, **kwargs)
        client = TestClient(app, base_url=WORKER_URL)
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for client in clients:
        client.__exit__(None, None, None)


@pytest.fixture
def client(make_client: Callable[..., TestClient]) -> TestClient:
    return make_client()


def upload(
    client: TestClient, path: Path, *, title: str = "Morning walk", confirmed: str = "true"
) -> dict:
    with path.open("rb") as handle:
        response = client.post(
            "/episodes",
            data={"title": title, "ownershipConfirmed": confirmed},
            files={"file": (path.name, handle, "application/octet-stream")},
        )
    return {"status": response.status_code, "body": response.json()}


def wait_for_job(client: TestClient, job_id: str, *, timeout: float = 30) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = client.get(f"/jobs/{job_id}").json()
        if job["status"] in ("completed", "failed", "cancelled"):
            return job
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not finish: {job}")
