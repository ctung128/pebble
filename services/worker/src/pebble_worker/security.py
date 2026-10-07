"""
Local-boundary guards. The worker serves private audio, so besides binding to 127.0.0.1:

* Host header must be 127.0.0.1 or localhost (blocks DNS-rebinding attacks).
* Browser requests must come from an allowlisted origin. A request with an `Origin` header
  is rejected unless that origin is allowlisted; a browser request without one is rejected
  when `Sec-Fetch-Site` shows it came from another site (e.g. an <audio> tag on a web page).
  Non-browser clients (curl, tests) send neither header and are allowed — they already run
  on this machine.
* CORS uses the same explicit allowlist, never "*", and never allows credentials.
"""

from __future__ import annotations

from fastapi import FastAPI
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from .config import ALLOWED_HOST_NAMES, Settings

_CROSS_SITE = {"cross-site", "same-site"}


class OriginGuard:
    def __init__(self, app: ASGIApp, allowed_origins: tuple[str, ...]) -> None:
        self.app = app
        self.allowed = frozenset(allowed_origins)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            headers = {k.decode("latin-1"): v.decode("latin-1") for k, v in scope["headers"]}
            origin = headers.get("origin")
            fetch_site = headers.get("sec-fetch-site")
            if (origin is not None and origin not in self.allowed) or (
                origin is None and fetch_site in _CROSS_SITE
            ):
                response = JSONResponse(
                    {
                        "error": {
                            "code": "ORIGIN_NOT_ALLOWED",
                            "message": "This origin may not use the Pebble worker.",
                        }
                    },
                    status_code=403,
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def install(app: FastAPI, settings: Settings) -> None:
    # Starlette runs the last-added middleware first: Host → Origin → CORS → routes.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_credentials=False,
        # PATCH: episode rename (1.7). PUT: translation consent (ADR 0008).
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "Range"],
        expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
        max_age=600,
    )
    app.add_middleware(OriginGuard, allowed_origins=settings.allowed_origins)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(ALLOWED_HOST_NAMES))
