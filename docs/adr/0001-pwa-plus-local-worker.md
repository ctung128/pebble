# ADR 0001 — Web app plus a localhost worker

**Status:** Accepted (2026-10-03)

## Context

Pebble's core value is turning audio the user owns into a timestamped Mandarin transcript.
The target user listens on apps whose transcripts can't be exported, so importing subtitles
does not solve the problem. Production-grade Mandarin ASR (FunASR/Paraformer) runs in Python
and is impractical in a browser for hour-long audio.

## Decision

- A React + TypeScript web app (`apps/web`) for all UI.
- A Python FastAPI worker (`services/worker`, from M0C) bound to `127.0.0.1` that owns audio,
  jobs and transcripts (filesystem + SQLite), runs FFmpeg preprocessing, and calls a
  `TranscriptionProvider`.
- A mock provider first; FunASR/Paraformer as the primary local provider in M1.
- SRT/VTT import exists only as a developer fallback, never the primary flow.

## Consequences

- Audio never leaves the machine; no server infrastructure to run or secure.
- Local mode needs a Python environment; the public demo must not (see ADR 0003).
- The UI talks to data only through `EpisodeSource`, so demo and local modes share components.
- A browser-only provider (e.g. ONNX/WASM) remains possible later behind the same interface.
