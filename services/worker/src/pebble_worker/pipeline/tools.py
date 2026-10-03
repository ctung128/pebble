"""Runs ffmpeg/ffprobe as subprocesses, with cancellation and structured failures."""

from __future__ import annotations

import subprocess
from collections.abc import Callable, Sequence

from ..errors import Cancelled, FailureCode, PipelineError

CancelCheck = Callable[[], bool]
_POLL_SECONDS = 0.2


def never_cancelled() -> bool:
    return False


def run_tool(
    args: Sequence[str], cancel: CancelCheck = never_cancelled
) -> subprocess.CompletedProcess[str]:
    """
    Runs a tool to completion, polling for cancellation. Raises FFMPEG_NOT_FOUND if the binary
    is missing; returns the completed process otherwise (callers interpret the exit code).
    """
    try:
        process = subprocess.Popen(
            list(args),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except FileNotFoundError as error:
        raise PipelineError(
            FailureCode.FFMPEG_NOT_FOUND,
            f"{args[0]} was not found.",
            hint="Install FFmpeg (e.g. `brew install ffmpeg`), then retry.",
        ) from error

    while True:
        try:
            stdout, stderr = process.communicate(timeout=_POLL_SECONDS)
            return subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)
        except subprocess.TimeoutExpired:
            if cancel():
                process.terminate()
                try:
                    process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate()
                raise Cancelled() from None


def tool_version(binary: str) -> str | None:
    """`ffmpeg -version` → "8.0", or None if the tool can't run."""
    try:
        result = subprocess.run(
            [binary, "-version"], capture_output=True, text=True, timeout=10, check=False
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    parts = result.stdout.split()
    return parts[2] if len(parts) > 2 and parts[1] == "version" else "unknown"
