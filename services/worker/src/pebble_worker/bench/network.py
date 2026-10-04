"""Blocks and counts network use for the whole benchmark process, as the real-model test does."""

from __future__ import annotations

import socket

_attempts: list[str] = []
_installed = False


def block_network() -> None:
    global _installed
    if _installed:
        return

    def refuse(kind: str):
        def blocked(*args: object, **kwargs: object) -> None:
            _attempts.append(kind)
            raise OSError("network blocked by pebble-worker bench")

        return blocked

    socket.socket.connect = refuse("connect")  # type: ignore[method-assign]
    socket.socket.connect_ex = refuse("connect_ex")  # type: ignore[method-assign,assignment]
    socket.getaddrinfo = refuse("getaddrinfo")  # type: ignore[assignment]
    _installed = True


def attempts() -> int:
    return len(_attempts)
