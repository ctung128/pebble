"""
`pebble-worker check` (behind `npm run pebble:doctor`) and the worker's port pre-check.
Fake model files only; temporary data directories; no network.
"""

from __future__ import annotations

import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from test_funasr_provider import SPECS, install_models

from pebble_worker.checks import port_state, run_checks
from pebble_worker.cli import main
from pebble_worker.config import Settings
from pebble_worker.contract import CURRENT_SCHEMA_VERSION
from pebble_worker.errors import ConfigError
from pebble_worker.health import check_health
from pebble_worker.models.verify import model_dir
from pebble_worker.storage import Storage

SPECS_LIST = list(SPECS.values())


def snapshot(root):
    return sorted((str(p.relative_to(root)), p.stat().st_mtime_ns) for p in root.rglob("*"))


@pytest.fixture
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("checks must not use the network")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)


def test_check_creates_nothing_in_a_fresh_data_directory(tmp_path, no_network):
    root = tmp_path / "pebble"
    result = run_checks(Settings(data_dir=root), specs=SPECS_LIST)
    assert not root.exists()
    assert result["dataDir"]["exists"] is False
    assert result["models"]["state"] == "missing" and result["models"]["verified"] is None
    assert result["disk"]["freeBytes"] > 0


def test_check_and_verify_change_nothing_in_an_existing_data_directory(tmp_path, no_network):
    storage = Storage(tmp_path / "pebble")
    storage.ensure()
    install_models(storage)
    before = snapshot(storage.root)
    quick = run_checks(Settings(data_dir=storage.root), specs=SPECS_LIST)
    full = run_checks(Settings(data_dir=storage.root), verify=True, specs=SPECS_LIST)
    assert snapshot(storage.root) == before
    assert not storage.db_path.exists()  # no database created or migrated
    assert quick["models"]["state"] == "present" and quick["models"]["verified"] is None
    assert full["models"]["state"] == "verified" and full["models"]["verified"] is True


def test_model_states_are_reported_without_hashing_by_default(tmp_path):
    storage = Storage(tmp_path / "pebble")
    storage.ensure()
    install_models(storage)
    asr = SPECS["asr"]
    (model_dir(storage, asr) / "model.pt").unlink()
    assert run_checks(Settings(data_dir=storage.root), specs=SPECS_LIST)["models"]["state"] == (
        "incomplete"
    )
    install_models(storage, {"configuration.json": b"{}", "model.pt": b"weights!"})
    assert run_checks(Settings(data_dir=storage.root), specs=SPECS_LIST)["models"]["state"] == (
        "wrong_size"
    )
    install_models(storage, {"configuration.json": b"[]", "model.pt": b"WEIGHTS"})  # same sizes
    quick = run_checks(Settings(data_dir=storage.root), specs=SPECS_LIST)["models"]
    full = run_checks(Settings(data_dir=storage.root), verify=True, specs=SPECS_LIST)["models"]
    assert quick["state"] == "present"  # sizes match: only --verify can tell
    assert full["state"] == "failed" and full["verified"] is False


def test_check_cli_prints_json_and_creates_nothing(monkeypatch, tmp_path, capsys):
    root = tmp_path / "pebble"
    monkeypatch.setenv("PEBBLE_DATA_DIR", str(root))
    assert main(["check", "--json"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert set(result) == {
        "python",
        "ffmpeg",
        "ffprobe",
        "dataDir",
        "environment",
        "models",
        "disk",
    }
    assert not root.exists()


# --- port pre-check -------------------------------------------------------------------------


def _listener(host="127.0.0.1"):
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind((host, 0))
    server.listen()
    return server


def test_a_listening_program_occupies_the_port():
    with _listener() as busy:
        assert port_state("127.0.0.1", busy.getsockname()[1]) == "other"


def test_a_listener_on_every_address_occupies_the_port():
    with _listener("0.0.0.0") as busy:
        assert port_state("127.0.0.1", busy.getsockname()[1]) == "other"


def test_a_port_is_free_after_its_previous_server_closed_connections():
    server = _listener()
    port = server.getsockname()[1]
    client = socket.create_connection(("127.0.0.1", port))
    accepted, _ = server.accept()
    accepted.close()  # the server side closes first, leaving TIME_WAIT behind
    client.close()
    server.close()
    assert port_state("127.0.0.1", port) == "free"


def test_a_pebble_worker_is_recognised():
    missing = Path("/nonexistent-pebble")
    payload = check_health(Settings(data_dir=missing), Storage(missing), []).dump()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        assert port_state("127.0.0.1", server.server_address[1]) == "pebble"
    finally:
        server.shutdown()
        server.server_close()


def test_serve_names_a_running_pebble_worker(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("PEBBLE_DATA_DIR", str(tmp_path / "pebble"))
    monkeypatch.setattr("pebble_worker.cli.port_state", lambda host, port: "pebble")
    assert main(["serve"]) == 2
    assert "a Pebble worker is already running" in capsys.readouterr().err


# --- instanceId -------------------------------------------------------------------------------


def test_health_reports_the_instance_id_only_when_set(tmp_path):
    storage = Storage(tmp_path / "pebble")
    storage.ensure()
    plain = check_health(Settings(data_dir=storage.root), storage, []).dump()
    assert "instanceId" not in plain
    nonce = "0123456789abcdef0123456789abcdef"
    tagged = check_health(Settings(data_dir=storage.root, instance_id=nonce), storage, []).dump()
    assert tagged["instanceId"] == nonce and tagged["schemaVersion"] == CURRENT_SCHEMA_VERSION


@pytest.mark.parametrize("bad", ["short", "0123456789ABCDEF0123456789ABCDEF", "x" * 32])
def test_instance_ids_must_be_lowercase_hex(tmp_path, bad):
    with pytest.raises(ConfigError, match="PEBBLE_INSTANCE_ID"):
        Settings.from_env({"PEBBLE_DATA_DIR": str(tmp_path), "PEBBLE_INSTANCE_ID": bad})
