"""`pebble-worker doctor` and `serve` startup checks."""

from __future__ import annotations

import pytest

from pebble_worker.cli import main


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("PEBBLE_DATA_DIR", str(tmp_path / "pebble"))
    for name in ("PEBBLE_HOST", "PEBBLE_FFMPEG", "PEBBLE_FFPROBE"):
        monkeypatch.delenv(name, raising=False)
    return tmp_path / "pebble"


def test_doctor_passes_and_creates_a_private_data_directory(env, capsys):
    assert main(["doctor"]) == 0
    out = capsys.readouterr().out
    assert "ffmpeg" in out and "ffprobe" in out and "All checks passed." in out
    assert "schema v3 of 3" in out  # 2: translation tables (ADR 0008); 3: speakers (ADR 0009)
    assert "loopback only" in out
    assert env.stat().st_mode & 0o777 == 0o700


def test_doctor_fails_when_ffmpeg_is_missing(env, monkeypatch, capsys):
    monkeypatch.setenv("PEBBLE_FFMPEG", "/nonexistent/ffmpeg")
    assert main(["doctor"]) == 1
    assert "not found" in capsys.readouterr().out


@pytest.mark.parametrize("argv", [["serve", "--host", "0.0.0.0"], ["serve", "--host", "localhost"]])
def test_serve_refuses_non_loopback_hosts_before_starting(env, argv, capsys):
    assert main(argv) == 2
    assert "only listens on 127.0.0.1" in capsys.readouterr().err


def test_serve_refuses_host_from_environment(env, monkeypatch, capsys):
    monkeypatch.setenv("PEBBLE_HOST", "0.0.0.0")
    assert main(["serve"]) == 2


def test_chunking_is_configurable_from_the_environment(env, monkeypatch, capsys):
    monkeypatch.setenv("PEBBLE_CHUNK_TARGET_SECONDS", "200")
    monkeypatch.setenv("PEBBLE_CHUNK_MAX_SECONDS", "300")
    assert main(["doctor"]) == 0
    assert "target 200s, range 120–300s" in capsys.readouterr().out


def test_invalid_chunking_is_refused(env, monkeypatch, capsys):
    monkeypatch.setenv("PEBBLE_CHUNK_MIN_SECONDS", "500")
    assert main(["doctor"]) == 2
    assert "min <= target <= max" in capsys.readouterr().err


def test_serve_explains_a_busy_port_instead_of_crashing(env, monkeypatch, capsys):
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as busy:
        busy.bind(("127.0.0.1", 0))
        busy.listen()
        port = busy.getsockname()[1]
        monkeypatch.setenv("PEBBLE_PORT", str(port))
        assert main(["serve"]) == 2
    assert f"port {port} on 127.0.0.1 is already in use" in capsys.readouterr().err


def test_default_port_avoids_ankiconnect():
    from pebble_worker.config import DEFAULT_PORT

    assert DEFAULT_PORT != 8765  # AnkiConnect's default
