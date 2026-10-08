"""
Network isolation for the speaker child process (ADR 0009).

The enforced boundary is the operating system's: on macOS the child is started through
`/usr/bin/sandbox-exec` with a Seatbelt profile that denies all networking. The kernel applies it
to the child and every descendant (Python or native), and it can't be lifted from inside. No
privileges are needed. On any other platform, or if the tool is missing, there is no enforced
boundary, so the run fails with NETWORK_ISOLATION_FAILED: there is no unrestricted fallback.

Inside the child, `os_network_denied` proves the boundary before any model code is imported: a
TCP connect to 127.0.0.1:9 (nothing listens there; no payload is sent; 1 s timeout) must fail with
EPERM/EACCES, as Seatbelt reports, rather than "connection refused", as an unsandboxed process
sees. The Python-level guard (`deny_network`) is installed afterwards as defense in depth only.
"""

from __future__ import annotations

import errno
import socket
import sys
from collections.abc import Sequence
from pathlib import Path

SANDBOX_EXEC = Path("/usr/bin/sandbox-exec")
#: Everything a normal process may do, except any network operation (TCP, UDP, Unix-domain
#: sockets, name lookups through system services).
SEATBELT_PROFILE = "(version 1)(allow default)(deny network*)"
PROBE_ADDRESS = ("127.0.0.1", 9)  # the discard port; a closed port on a normal Mac
PROBE_TIMEOUT_SECONDS = 1.0
REFUSAL = "network blocked by Pebble speaker isolation"
_DENIED_ERRNOS = {errno.EPERM, errno.EACCES}
_installed = False


class IsolationUnavailable(Exception):
    """No enforced network boundary on this platform."""


def isolated_command(argv: Sequence[str]) -> list[str]:
    """`argv` wrapped so the OS denies it (and its descendants) all networking."""
    if sys.platform != "darwin" or not SANDBOX_EXEC.is_file():
        raise IsolationUnavailable(sys.platform)
    return [str(SANDBOX_EXEC), "-p", SEATBELT_PROFILE, *argv]


def os_network_denied() -> bool:
    """
    True only if the operating system refuses a connection with a permission error. A refused,
    timed-out or (unexpectedly) successful connection all mean there is no enforced boundary.
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.settimeout(PROBE_TIMEOUT_SECONDS)
    try:
        probe.connect(PROBE_ADDRESS)
    except OSError as error:
        return error.errno in _DENIED_ERRNOS
    finally:
        probe.close()
    return False


def _refuse(*args: object, **kwargs: object) -> None:
    raise OSError(REFUSAL)


def deny_network() -> None:
    """Defense in depth: Python-level refusal of connections and lookups in this process."""
    global _installed
    socket.socket.connect = _refuse  # type: ignore[method-assign,assignment]
    socket.socket.connect_ex = _refuse  # type: ignore[method-assign,assignment]
    socket.socket.sendto = _refuse  # type: ignore[method-assign,assignment]
    socket.create_connection = _refuse  # type: ignore[assignment]
    socket.getaddrinfo = _refuse  # type: ignore[assignment]
    _installed = True


def network_denied() -> bool:
    """True only if the Python-level guard refuses a lookup and a connection (no I/O happens)."""
    if not _installed:
        return False

    def connect() -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.connect(("127.0.0.1", 9))

    for attempt in (lambda: socket.getaddrinfo("localhost", 80), connect):
        try:
            attempt()
        except OSError as error:
            if str(error) != REFUSAL:
                return False
        else:
            return False
    return True


def available() -> bool:
    """Cheap: whether the enforced boundary exists on this machine (no process is started)."""
    return sys.platform == "darwin" and SANDBOX_EXEC.is_file()
