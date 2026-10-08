"""
OS-level network denial for the speaker child (ADR 0009), with synthetic children only.

Every probe is a bounded connection attempt to 127.0.0.1:9 (nothing listens there) or a
zero-length UDP datagram to it: no listener is opened, no payload is sent, nothing leaves the
machine. Inside the sandbox the OS answers EPERM ("Operation not permitted"); outside it, a closed
port answers ECONNREFUSED.
"""

from __future__ import annotations

import json
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from pebble_worker.speakers import isolation, runner
from pebble_worker.speakers.core import LineSpan
from pebble_worker.storage import Storage

pytestmark = pytest.mark.skipif(
    sys.platform != "darwin" or not isolation.SANDBOX_EXEC.is_file(),
    reason="the enforced boundary is macOS Seatbelt",
)

PROBES = textwrap.dedent(
    """
    import errno, json, os, socket, subprocess, sys

    def tcp():
        s = socket.socket(); s.settimeout(1)
        try:
            s.connect(("127.0.0.1", 9)); return "connected"
        except OSError as e:
            return errno.errorcode.get(e.errno, str(e.errno))
        finally:
            s.close()

    def udp():
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.sendto(b"", ("127.0.0.1", 9)); return "sent"
        except OSError as e:
            return errno.errorcode.get(e.errno, str(e.errno))
        finally:
            s.close()

    out = {"tcp": tcp(), "udp": udp()}
    if len(sys.argv) > 1 and sys.argv[1] == "descend":
        # A Python grandchild and a native binary, both started from inside.
        grandchild = subprocess.run(
            [sys.executable, "-I", "-c", sys.argv[2]], capture_output=True, text=True, timeout=30
        )
        out["grandchild"] = json.loads(grandchild.stdout)
        native = subprocess.run(
            ["/usr/bin/nc", "-vz", "-w", "1", "127.0.0.1", "9"],
            capture_output=True, text=True, timeout=30,
        )
        out["native"] = native.stderr.strip()
    print(json.dumps(out))
    """
)


def run(argv: list[str]) -> dict:
    done = subprocess.run(argv, capture_output=True, text=True, timeout=60, check=True)
    return json.loads(done.stdout)


def test_the_command_is_wrapped_with_the_fixed_tool_and_profile():
    wrapped = isolation.isolated_command(["python", "-m", "x", "spec.json"])
    assert wrapped[:3] == [
        "/usr/bin/sandbox-exec",
        "-p",
        "(version 1)(allow default)(deny network*)",
    ]
    assert wrapped[3:] == ["python", "-m", "x", "spec.json"]


def test_unsandboxed_baseline_is_refused_not_denied():
    # Shows the probe distinguishes the two cases: no sandbox → a closed port's refusal.
    seen = run([sys.executable, "-I", "-c", PROBES])
    assert seen["tcp"] == "ECONNREFUSED"


def test_python_and_native_descendants_are_all_denied():
    seen = run(isolation.isolated_command([sys.executable, "-I", "-c", PROBES, "descend", PROBES]))
    assert seen["tcp"] == "EPERM" and seen["udp"] == "EPERM"
    assert seen["grandchild"] == {"tcp": "EPERM", "udp": "EPERM"}
    assert "Operation not permitted" in seen["native"]


def test_local_files_stay_usable_inside_the_sandbox(tmp_path):
    model = tmp_path / "models" / "weights.bin"
    model.parent.mkdir()
    model.write_bytes(b"invented weights")
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    code = (
        "import sys, pathlib; data = pathlib.Path(sys.argv[1]).read_bytes(); "
        "pathlib.Path(sys.argv[2], 'out.bin').write_bytes(data[::-1]); print('{}')"
    )
    run(isolation.isolated_command([sys.executable, "-I", "-c", code, str(model), str(scratch)]))
    assert (scratch / "out.bin").read_bytes() == b"invented weights"[::-1]


def test_the_child_proof_holds_only_inside_the_sandbox():
    code = "from pebble_worker.speakers import isolation; print(isolation.os_network_denied())"
    outside = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, timeout=60
    )
    inside = subprocess.run(
        isolation.isolated_command([sys.executable, "-c", code]),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert outside.stdout.strip() == "False" and inside.stdout.strip() == "True"


def test_the_real_child_started_without_the_sandbox_refuses_to_run(tmp_path):
    spec = tmp_path / "spec.json"
    result = tmp_path / "result.json"
    spec.write_text(
        json.dumps(
            {
                "audio": str(tmp_path / "none.wav"),
                "lines": [],
                "deadlineAt": 0,
                "result": str(result),
                "numbaCache": str(tmp_path / "numba"),
            }
        )
    )
    done = subprocess.run(
        [sys.executable, "-m", "pebble_worker.speakers.child", str(spec)],
        env={"PATH": "/usr/bin:/bin", "PEBBLE_DATA_DIR": str(tmp_path / "pebble")},
        capture_output=True,
        timeout=60,
        check=False,
    )
    assert done.returncode == 3
    assert json.loads(result.read_text()) == {"error": "NETWORK_ISOLATION_FAILED"}


def test_no_fallback_when_the_sandbox_is_unavailable(tmp_path, monkeypatch):
    marker = tmp_path / "ran"
    script = tmp_path / "child.py"
    script.write_text(f"open({str(marker)!r}, 'w').write('ran')\n")
    monkeypatch.setattr(isolation, "SANDBOX_EXEC", Path("/nonexistent/sandbox-exec"))
    storage = Storage(tmp_path / "pebble")
    outcome = runner.run_child(
        storage,
        audio=tmp_path / "a.wav",
        lines=[LineSpan("seg-0001", 0, 1000)],
        timeout_seconds=30,
        command=[sys.executable, str(script)],
    )
    assert outcome.code == "NETWORK_ISOLATION_FAILED" and not marker.exists()
    assert list(storage.tmp_dir.iterdir()) == []
    monkeypatch.setattr(isolation.sys, "platform", "linux")
    with pytest.raises(isolation.IsolationUnavailable):
        isolation.isolated_command(["x"])
