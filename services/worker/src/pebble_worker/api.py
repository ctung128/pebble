"""Localhost HTTP API. Responses use the shared contract (camelCase JSON)."""

from __future__ import annotations

import os
import shutil
import tempfile
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from fastapi import FastAPI, File, Form, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Receive, Scope, Send

from . import security
from .config import Settings
from .contract import CURRENT_SCHEMA_VERSION, Episode, Manifest
from .db import Database, now_iso
from .errors import StorageAccessError
from .health import check_health
from .jobs import ACTIVE_STATUSES, JobConflict, JobRunner, JobService, Pipeline
from .providers.base import TranscriptionProvider
from .providers.factory import build_provider
from .storage import EPISODE_ID, PRIVATE_DIR, PRIVATE_FILE, Storage

#: Accepted upload extensions → MIME type served back to the browser.
AUDIO_EXTENSIONS: dict[str, str] = {
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".aac": "audio/aac",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg",
    ".webm": "audio/webm",
}
MAX_TITLE_LENGTH = 200
_COPY_BUFFER = 1024 * 1024


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, hint: str | None = None) -> None:
        super().__init__(message)
        self.status, self.code, self.message, self.hint = status, code, message, hint


def _error(status: int, code: str, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message, **extra}}, status_code=status)


class UploadLimit:
    """Rejects oversized (or unsized) uploads before the body is read."""

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["method"] == "POST" and scope["path"] == "/episodes":
            headers = dict(scope["headers"])
            length = headers.get(b"content-length")
            if length is None:
                await _error(411, "LENGTH_REQUIRED", "Uploads must declare their size.")(
                    scope, receive, send
                )
                return
            if int(length) > self.max_bytes:
                limit_mb = self.max_bytes // (1024 * 1024)
                await _error(
                    413, "FILE_TOO_LARGE", f"The file is larger than the {limit_mb} MB limit."
                )(scope, receive, send)
                return
        await self.app(scope, receive, send)


def create_app(
    settings: Settings,
    *,
    provider: TranscriptionProvider | None = None,
    start_runner: bool = True,
) -> FastAPI:
    storage = Storage(settings.data_dir)
    storage.ensure()
    # Spool multipart uploads inside the private data directory, not the system temp dir.
    tempfile.tempdir = str(storage.tmp_dir)
    db = Database(storage.db_path)
    db.migrate()
    provider = provider or build_provider(settings, storage)
    service = JobService(db, provider)
    runner = JobRunner(Pipeline(settings, storage, service))

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        provider.prepare()  # e.g. FunASR model verification, in the background
        if start_runner:
            runner.start()
        yield
        runner.stop()

    # No interactive docs or schema endpoint: nothing beyond the routes below is exposed.
    app = FastAPI(
        title="Pebble worker", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None
    )
    app.state.storage, app.state.db, app.state.service, app.state.runner = (
        storage,
        db,
        service,
        runner,
    )
    app.add_middleware(UploadLimit, max_bytes=settings.max_upload_bytes)
    security.install(app, settings)

    @app.exception_handler(ApiError)
    async def api_error(_: Request, error: ApiError) -> JSONResponse:
        extra = {"hint": error.hint} if error.hint else {}
        return _error(error.status, error.code, error.message, **extra)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_: Request, error: RequestValidationError) -> JSONResponse:
        fields = [".".join(str(p) for p in e["loc"]) for e in error.errors()]
        return _error(
            422, "INVALID_REQUEST", "The request is missing or has invalid fields.", fields=fields
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, error: StarletteHTTPException) -> JSONResponse:
        code = "NOT_FOUND" if error.status_code == 404 else "HTTP_ERROR"
        return _error(error.status_code, code, str(error.detail))

    @app.exception_handler(StorageAccessError)
    async def storage_access(_: Request, __: StorageAccessError) -> JSONResponse:
        return _error(404, "NOT_FOUND", "Not found.")

    # --- helpers --------------------------------------------------------------------------

    def episode_row(episode_id: str) -> Any:
        if not EPISODE_ID.match(episode_id):
            raise ApiError(404, "NOT_FOUND", "No such episode.")
        with db.tx() as conn:
            row = conn.execute(
                """SELECT e.*, j.status AS job_status FROM episodes e
                   JOIN jobs j ON j.episode_id = e.id WHERE e.id = ?""",
                (episode_id,),
            ).fetchone()
        if row is None:
            raise ApiError(404, "NOT_FOUND", "No such episode.")
        return row

    def ready_episode_row(episode_id: str) -> Any:
        row = episode_row(episode_id)
        if row["job_status"] != "completed":
            raise ApiError(409, "EPISODE_NOT_READY", "This episode hasn't finished processing.")
        return row

    def to_episode(row: Any) -> Episode:
        return Episode.model_validate(
            {
                "id": row["id"],
                "title": row["title"],
                "description": f"Local audio · {row['original_filename']}",
                "language": row["language"],
                "durationMs": row["duration_ms"],
                "audio": {"src": f"episodes/{row['id']}/audio", "mimeType": row["mime_type"]},
                "transcript": {"src": f"episodes/{row['id']}/transcript"},
                "audioProvenance": {
                    "kind": "user-provided",
                    "publishable": False,
                    "notes": "A local file you provided; ownership confirmed at upload. "
                    "Stays on this computer.",
                },
            }
        )

    def job_or_404(job_id: str) -> Any:
        job = service.get(job_id)
        if job is None:
            raise ApiError(404, "NOT_FOUND", "No such job.")
        return job

    # --- routes ---------------------------------------------------------------------------

    @app.get("/health")
    def health() -> dict[str, Any]:
        return check_health(settings, storage, [provider]).dump()

    @app.get("/episodes")
    def list_episodes() -> dict[str, Any]:
        """Episodes ready to read (their job completed). In-progress work is under /jobs."""
        with db.tx() as conn:
            rows = conn.execute(
                """SELECT e.* FROM episodes e JOIN jobs j ON j.episode_id = e.id
                   WHERE j.status = 'completed' ORDER BY e.created_at DESC"""
            ).fetchall()
        manifest = Manifest(
            schema_version=CURRENT_SCHEMA_VERSION, episodes=[to_episode(r) for r in rows]
        )
        return manifest.dump()

    @app.post("/episodes", status_code=201)
    def create_episode(
        file: Annotated[UploadFile, File()],
        title: Annotated[str, Form()],
        ownership_confirmed: Annotated[str, Form(alias="ownershipConfirmed")] = "",
    ) -> dict[str, Any]:
        if ownership_confirmed != "true":
            raise ApiError(
                422,
                "OWNERSHIP_NOT_CONFIRMED",
                "Confirm that you own this audio or are authorized to process it.",
            )
        clean_title = title.strip()
        if not clean_title or len(clean_title) > MAX_TITLE_LENGTH:
            raise ApiError(
                422,
                "INVALID_TITLE",
                f"Give the episode a title of 1–{MAX_TITLE_LENGTH} characters.",
            )
        filename = Path(file.filename or "").name
        extension = Path(filename).suffix.lower()
        mime_type = AUDIO_EXTENSIONS.get(extension)
        if mime_type is None:
            raise ApiError(
                415,
                "UNSUPPORTED_MEDIA",
                "This file type isn't supported.",
                hint="Use " + ", ".join(sorted(AUDIO_EXTENSIONS)) + ".",
            )

        episode_id = f"ep-{uuid.uuid4().hex[:12]}"
        directory = storage.episode_dir(episode_id)
        directory.mkdir(parents=True, mode=PRIVATE_DIR)
        source = directory / f"source{extension}"
        try:
            fd = os.open(source, os.O_WRONLY | os.O_CREAT | os.O_EXCL, PRIVATE_FILE)
            with os.fdopen(fd, "wb") as out:
                shutil.copyfileobj(file.file, out, _COPY_BUFFER)
            if source.stat().st_size == 0:
                raise ApiError(422, "EMPTY_FILE", "The file is empty.")
            stamp = now_iso()
            with db.tx() as conn:
                conn.execute(
                    """INSERT INTO episodes (id, title, original_filename, source_path,
                                             mime_type, ownership_confirmed_at, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (
                        episode_id,
                        clean_title,
                        filename,
                        storage.relative(source),
                        mime_type,
                        stamp,
                        stamp,
                    ),
                )
                job_id = service.create(conn, episode_id)
        except ApiError:
            storage.remove_episode(episode_id)
            raise
        except OSError as error:
            storage.remove_episode(episode_id)
            raise ApiError(
                507, "STORAGE_ERROR", "The file couldn't be saved.", hint="Check free disk space."
            ) from error

        # Read the job before submitting it, so the response reliably shows the created state.
        job = service.get(job_id)
        assert job is not None
        runner.submit(job_id)
        return {"job": job.dump()}

    @app.get("/episodes/{episode_id}")
    def get_episode(episode_id: str) -> dict[str, Any]:
        return to_episode(ready_episode_row(episode_id)).dump()

    @app.get("/episodes/{episode_id}/audio")
    def get_audio(episode_id: str) -> FileResponse:
        row = ready_episode_row(episode_id)
        path = storage.resolve_relative(row["source_path"])  # refuses paths outside data dir
        if not path.is_file():
            raise ApiError(404, "NOT_FOUND", "The audio file is missing.")
        return FileResponse(path, media_type=row["mime_type"])

    @app.get("/episodes/{episode_id}/transcript")
    def get_transcript(episode_id: str) -> Response:
        ready_episode_row(episode_id)
        with db.tx() as conn:
            row = conn.execute(
                "SELECT body FROM transcripts WHERE episode_id = ?", (episode_id,)
            ).fetchone()
        if row is None:
            raise ApiError(404, "NOT_FOUND", "No transcript for this episode.")
        return Response(row["body"], media_type="application/json")

    @app.delete("/episodes/{episode_id}", status_code=204)
    def delete_episode(episode_id: str) -> Response:
        row = episode_row(episode_id)
        if row["job_status"] in ACTIVE_STATUSES:
            raise ApiError(
                409, "JOB_ACTIVE", "This episode is still processing.", hint="Cancel the job first."
            )
        storage.remove_episode(episode_id)
        with db.tx() as conn:
            conn.execute("DELETE FROM episodes WHERE id = ?", (episode_id,))
        return Response(status_code=204)

    @app.get("/jobs")
    def list_jobs() -> dict[str, Any]:
        return {
            "schemaVersion": CURRENT_SCHEMA_VERSION,
            "jobs": [job.dump() for job in service.list()],
        }

    @app.get("/jobs/{job_id}")
    def get_job(job_id: str) -> dict[str, Any]:
        return job_or_404(job_id).dump()

    @app.post("/jobs/{job_id}/cancel")
    def cancel_job(job_id: str) -> dict[str, Any]:
        job_or_404(job_id)
        try:
            return service.request_cancel(job_id).dump()
        except JobConflict as error:
            raise ApiError(409, "JOB_NOT_ACTIVE", str(error)) from error

    @app.post("/jobs/{job_id}/retry")
    def retry_job(job_id: str) -> dict[str, Any]:
        job_or_404(job_id)
        try:
            job = service.retry(job_id)
        except JobConflict as error:
            raise ApiError(409, "JOB_NOT_RETRYABLE", str(error)) from error
        runner.submit(job_id)
        return job.dump()

    return app
