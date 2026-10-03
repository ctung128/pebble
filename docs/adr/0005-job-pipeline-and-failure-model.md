# ADR 0005 — Job pipeline and failure model

**Status:** Accepted (2026-10-03)

## Context

Local transcription of long audio takes minutes to hours, can fail at several points (bad
media, missing FFmpeg, provider errors, the worker being stopped), and must report progress
truthfully. The web app polls for status; it must never show partial or invented results.

## Decision

- **One job per episode, one job running at a time**, in submission order, on a single
  background thread. SQLite records jobs, per-attempt chunk rows and transcripts.
- **Stages:** probing → normalizing → chunking → transcribing → merging. Progress is reported
  only where it is real: completed chunks out of the known total during transcription.
- **Structured failures** `{stage, code, message, retryable, hint}` with a fixed code list.
- **Cancellation** is checked at safe points (between stages and chunks) and while FFmpeg
  runs; a cancelled queued job never starts. Jobs are claimed atomically, so a cancel that
  lands first always wins.
- **Retry is conservative.** It restarts from the source audio with a cleared work
  directory. Earlier attempts' chunk rows are kept but never merged; merge reads only the
  current attempt and only when all of its chunks are done.
- **Worker restart** turns running jobs into `WORKER_RESTARTED` failures that need an
  explicit retry. Queued jobs that never started run normally.
- **Silence-aware chunking** with configurable target/min/max (development defaults
  150/120/240 s), sample-exact slices of the normalized WAV, hard cut when no silence fits.
- **Mock provider first**, labelled `mock` in transcript provenance and job data, never
  `asr`.

## Consequences

- Retrying redoes completed work. Acceptable for M0C; per-chunk resume can be added later on
  top of the preserved chunk records once real providers show it is worth the complexity.
- One job at a time keeps CPU use predictable for FunASR (M1), at the cost of throughput.
- Chunk boundaries are hard edges; whether FunASR needs overlap is an M1 benchmark question.
