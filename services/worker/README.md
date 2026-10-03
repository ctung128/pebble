# Pebble worker

Private, on-device audio processing for the Pebble web app: a FastAPI service on
`127.0.0.1:8790` with an SQLite job store, an FFmpeg pipeline (probe → normalize → silence-aware
chunking → transcription → merge) and a provider interface. M0C-1 ships only the **mock**
provider, which produces labelled placeholder text and never transcribes audio.

Usage, data handling, pipeline, failures, retry semantics, API and security:
**[docs/LOCAL_MODE.md](../../docs/LOCAL_MODE.md)**.

```bash
uv run pebble-worker doctor
uv run pebble-worker serve
uv run pytest
uv run ruff check . && uv run ruff format --check .
```

## Layout

```
src/pebble_worker/
  cli.py          serve / doctor
  config.py       settings from PEBBLE_* env (loopback-only, origin allowlist, chunking)
  security.py     Host check, origin guard, CORS
  api.py          HTTP routes, upload handling, error envelope
  jobs.py         job service, state machine, pipeline runner (one job at a time)
  db.py           SQLite schema + numbered migrations
  storage.py      data directory layout and path containment
  contract.py     Pydantic models mirroring packages/schema (Zod)
  health.py       /health and doctor checks
  errors.py       failure codes and retryability
  pipeline/       tools (subprocess + cancel), probe, normalize, chunk, merge
  providers/      base protocol, mock
tests/            generated audio only — no binary fixtures
```
