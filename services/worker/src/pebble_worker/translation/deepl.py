"""
The DeepL client: one Chinese line per request to the fixed DeepL API host (ADR 0008).

Direct HTTPS only, through `http.client`: certificate and hostname verification, no redirects
(http.client never follows them; any 3xx is a failure), no proxies (the connection is opened
here, never tunnelled, and proxy settings are never read), one attempt, a bounded response.
Provider responses are reduced to a fixed code and HTTP status; their text is never logged,
stored or returned.

**Time bound.** Each request has an elapsed-time budget (`BUDGET_SECONDS`) on a monotonic
clock, started before the host name is resolved:

- name resolution runs in a helper thread; the request stops waiting for it when the budget
  runs out (the OS lookup may finish later, but it only resolves the fixed host: it can't
  start a request or store a result);
- every socket the request opens is watched: when the budget runs out, a watchdog shuts it
  down, which ends a blocked connect, TLS handshake, header read or body read;
- each blocking socket operation also times out at the budget's remaining time, and the body
  is read in chunks with the budget checked between them, so a slow drip of small chunks
  can't extend it.

Once the budget is spent the request fails with a timeout, even if a response arrived at the
last moment; its result is discarded. Noticing the timeout and cleaning up are subject to
thread-scheduling overhead, so the call can end slightly after the budget.
"""

from __future__ import annotations

import contextlib
import http.client
import json
import socket
import ssl
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

from ..contract import TRANSLATION_TARGET_LANGUAGE, validate_translated_text
from .config import SecretKey

HOST = "api-free.deepl.com"
PORT = 443
PATH = "/v2/translate"
#: The owner's whole provider operation; below the service's 20 s wait for joined requests.
BUDGET_SECONDS = 15.0
MAX_RESPONSE_BYTES = 64 * 1024
READ_CHUNK_BYTES = 16 * 1024


@dataclass(frozen=True)
class TransportResponse:
    status: int
    #: At most MAX_RESPONSE_BYTES + 1 bytes: one more than allowed means "too large".
    body: bytes


class HttpsTransport(Protocol):
    def post(self, path: str, headers: dict[str, str], body: bytes) -> TransportResponse: ...


class Deadline:
    """An elapsed-time budget on a monotonic clock."""

    def __init__(self, seconds: float, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._end = clock() + seconds

    def remaining(self) -> float:
        """Seconds left; raises TimeoutError once the budget is spent."""
        left = self._end - self._clock()
        if left <= 0:
            raise TimeoutError("translation time budget spent")
        return left


class Watchdog:
    """Shuts down every watched socket when the budget runs out (real time)."""

    def __init__(self, seconds: float) -> None:
        self.fired = False
        self._sockets: list[Any] = []
        self._lock = threading.Lock()
        self._timer = threading.Timer(seconds, self._fire)
        self._timer.daemon = True

    def start(self) -> None:
        self._timer.start()

    def cancel(self) -> None:
        self._timer.cancel()

    def watch(self, sock: Any) -> None:
        with self._lock:
            self._sockets.append(sock)
            fired = self.fired
        if fired:
            _shutdown(sock)
            raise TimeoutError("translation time budget spent")

    def _fire(self) -> None:
        with self._lock:
            self.fired = True
            sockets = list(self._sockets)
        for sock in sockets:
            _shutdown(sock)


def _shutdown(sock: Any) -> None:
    with contextlib.suppress(OSError):  # already closed or never connected
        sock.shutdown(socket.SHUT_RDWR)


Resolver = Callable[[str, int, Deadline], list[tuple[Any, ...]]]


def resolve(host: str, port: int, deadline: Deadline) -> list[tuple[Any, ...]]:
    """getaddrinfo in a helper thread, waited for at most the remaining budget."""
    box: dict[str, Any] = {}

    def run() -> None:
        try:
            box["infos"] = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except OSError as error:
            box["error"] = error

    helper = threading.Thread(target=run, name="pebble-deepl-resolve", daemon=True)
    helper.start()
    helper.join(deadline.remaining())
    if helper.is_alive():
        raise TimeoutError("name resolution took too long")
    if "error" in box:
        raise box["error"]
    return box["infos"]


class BoundedHTTPSConnection(http.client.HTTPSConnection):
    """
    HTTPSConnection to HOST:PORT that opens its own socket under the budget and watchdog,
    then wraps it with the verifying TLS context (SNI and hostname check on HOST). Never
    tunnels through a proxy.
    """

    def __init__(
        self,
        deadline: Deadline,
        watchdog: Watchdog,
        context: ssl.SSLContext,
        resolver: Resolver = resolve,
    ) -> None:
        super().__init__(HOST, PORT, timeout=deadline.remaining(), context=context)
        self._deadline = deadline
        self._watchdog = watchdog
        self._resolver = resolver
        self._tls = context

    def set_tunnel(self, *args: Any, **kwargs: Any) -> None:
        raise RuntimeError("Pebble never sends the DeepL request through a proxy")

    def connect(self) -> None:
        last: OSError | None = None
        raw: socket.socket | None = None
        for family, kind, proto, _, address in self._resolver(HOST, PORT, self._deadline):
            candidate = socket.socket(family, kind, proto)
            try:
                self._watchdog.watch(candidate)
                candidate.settimeout(self._deadline.remaining())
                candidate.connect(address)
                raw = candidate
                break
            except OSError as error:
                last = error
                candidate.close()
        if raw is None:
            raise last or OSError("no address for the DeepL host")
        raw.settimeout(self._deadline.remaining())
        wrapped = self._tls.wrap_socket(raw, server_hostname=HOST)
        self._watchdog.watch(wrapped)
        self.sock = wrapped


ConnectionFactory = Callable[[Deadline, Watchdog, ssl.SSLContext], Any]


class StdlibHttpsTransport:
    """POSTs to HOST:443 under the elapsed-time budget. Raises OSError-family errors."""

    def __init__(
        self,
        budget: float = BUDGET_SECONDS,
        *,
        clock: Callable[[], float] = time.monotonic,
        connection_factory: ConnectionFactory = BoundedHTTPSConnection,
    ) -> None:
        self.budget = budget
        self.clock = clock
        self.connection_factory = connection_factory

    @staticmethod
    def tls_context() -> ssl.SSLContext:
        context = ssl.create_default_context()
        context.check_hostname = True
        context.verify_mode = ssl.CERT_REQUIRED
        return context

    def post(self, path: str, headers: dict[str, str], body: bytes) -> TransportResponse:
        deadline = Deadline(self.budget, self.clock)
        watchdog = Watchdog(deadline.remaining())
        connection = self.connection_factory(deadline, watchdog, self.tls_context())
        watchdog.start()
        try:
            connection.request("POST", path, body=body, headers=headers)
            self._narrow(connection, deadline)
            response = connection.getresponse()
            received = bytearray()
            while len(received) <= MAX_RESPONSE_BYTES:
                self._narrow(connection, deadline)
                chunk = response.read1(
                    min(READ_CHUNK_BYTES, MAX_RESPONSE_BYTES + 1 - len(received))
                )
                if not chunk:
                    break
                received += chunk
            deadline.remaining()
            if watchdog.fired:
                raise TimeoutError("translation time budget spent")
            return TransportResponse(response.status, bytes(received[: MAX_RESPONSE_BYTES + 1]))
        except (OSError, http.client.HTTPException):
            if watchdog.fired:
                raise TimeoutError("translation time budget spent") from None
            raise
        finally:
            watchdog.cancel()
            connection.close()

    @staticmethod
    def _narrow(connection: Any, deadline: Deadline) -> None:
        """Checks the budget and caps the next blocking socket operation at what's left."""
        left = deadline.remaining()
        sock = getattr(connection, "sock", None)
        if sock is not None:
            sock.settimeout(left)


class ProviderFailure(Exception):
    """A failed translation, reduced to a fixed code and the HTTP status (if any)."""

    def __init__(self, code: str, http_status: int | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.http_status = http_status


#: DeepL HTTP statuses → Pebble's fixed codes (docs/TRANSLATION.md#errors).
_STATUS_CODES = {
    400: "TRANSLATION_REQUEST_REJECTED",
    403: "TRANSLATION_KEY_REJECTED",
    413: "TRANSLATION_REQUEST_REJECTED",
    429: "TRANSLATION_RATE_LIMITED",
    456: "TRANSLATION_PROVIDER_QUOTA",
}


def request_body(text: str) -> bytes:
    """Exactly one line and the language pair: nothing else."""
    return json.dumps(
        {"text": [text], "source_lang": "ZH", "target_lang": TRANSLATION_TARGET_LANGUAGE},
        ensure_ascii=False,
    ).encode("utf-8")


class DeepLClient:
    def __init__(self, key: SecretKey, transport: HttpsTransport | None = None) -> None:
        self._key = key
        self._transport = transport or StdlibHttpsTransport()

    def translate(self, text: str) -> str:
        headers = {
            "Authorization": f"DeepL-Auth-Key {self._key.reveal()}",
            "Content-Type": "application/json",
        }
        try:
            response = self._transport.post(PATH, headers, request_body(text))
        except (OSError, http.client.HTTPException) as error:
            # Timeouts, refused connections, TLS failures, protocol errors. Nothing from the
            # error is kept: its text could quote the server.
            raise ProviderFailure("TRANSLATION_UNAVAILABLE") from _scrubbed(error)
        if response.status != 200:
            code = _STATUS_CODES.get(response.status, "TRANSLATION_UNAVAILABLE")
            raise ProviderFailure(code, response.status)
        return _english(response)


def _english(response: TransportResponse) -> str:
    if len(response.body) > MAX_RESPONSE_BYTES:
        raise ProviderFailure("TRANSLATION_UNAVAILABLE", response.status)
    try:
        data = json.loads(response.body.decode("utf-8"))
        translations = data["translations"]
        if not isinstance(translations, list) or len(translations) != 1:
            raise ValueError("expected one translation")
        text = translations[0]["text"]
        if not isinstance(text, str):
            raise ValueError("expected text")
        return validate_translated_text(text)
    except (ValueError, KeyError, TypeError, IndexError, UnicodeDecodeError) as error:
        raise ProviderFailure("TRANSLATION_UNAVAILABLE", response.status) from _scrubbed(error)


def _scrubbed(error: BaseException) -> Exception:
    """A stand-in cause naming only the error's type, so chained tracebacks quote nothing."""
    return RuntimeError(type(error).__name__)
