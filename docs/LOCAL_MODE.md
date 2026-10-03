# Local mode: the Pebble worker

Local mode turns audio **you own or are authorized to use** into a timestamped transcript on
your own computer. A small Python worker does the processing; the Pebble web app talks to it
over `127.0.0.1` only. Nothing is uploaded to the internet.

> **Status: M0C-2.** The worker, its job pipeline, the **mock** transcription provider and the
> web app's local mode are built.

> [!IMPORTANT]
> **Current limitation:** the worker processes your real local audio through probe,
> normalization and chunking, but its M0C transcript output is **mock placeholder text**
> (such as `（模拟转写）第 1-1 段`), not recognized speech. The mock never listens to the
> audio. Real Mandarin speech recognition (FunASR) arrives in M1.

Pebble starts at a local audio file you choose. It does not fetch, download or scrape audio
from URLs or apps, and it does not work around any platform's content protections.

## Requirements

- macOS or Linux, Python 3.12+, [uv](https://docs.astral.sh/uv/), and FFmpeg (`ffmpeg` and
  `ffprobe` on `PATH`).
- No models, GPU, accounts or API keys.

## Commands

From the repository root:

```bash
npm run worker:doctor   # check Python, FFmpeg, the data directory, database and provider
npm run worker          # start on http://127.0.0.1:8790 (Ctrl+C to stop)
npm run test:worker     # pytest + ruff
```

`uv` creates the worker's private environment in `services/worker/.venv` on first use, using
your installed Python. (Set `UV_PYTHON_DOWNLOADS=never` if you want uv to refuse to download a
Python build.)

Pebble defaults to 127.0.0.1:8790 to avoid conflict with AnkiConnect, which commonly uses port 8765. If the port is busy, the worker says so and exits; choose another with `PEBBLE_PORT`.

## Using local mode in the browser

Local mode is a separate build of the web app; the public demo never contains it. In two
terminals, from the repository root:

```bash
npm run worker          # the worker on 127.0.0.1:8790
npm run dev:local       # the app in local mode on http://localhost:5175
```

Open **http://localhost:5175**. (Port 5175 lets local mode run alongside the demo dev server
on 5173; both are in the worker's default origin allowlist.)

1. **Worker status.** The app calls `/health` first and offers uploads only when it reads
   "Local worker is ready." Otherwise it explains what to fix — the worker isn't running
   (`npm run worker`), FFmpeg is missing (`brew install ffmpeg`, then
   `npm run worker:doctor`), the app and worker versions don't match, the data folder isn't
   accessible (with its path and the worker's hint), or the worker refused this page's
   address — and re-checks every few seconds.
2. **Process audio locally.** Choose a file (M4A, MP3, WAV, FLAC, OGG/Opus, WebM or AAC, up to
   2 GB), adjust the title (prefilled from the filename), confirm _"I own this audio or am
   authorized to process it. Pebble processes it only on this computer."_, and choose **Run
   processing preview**. Upload progress shows real bytes sent.
3. **Progress.** Stages are shown as they happen, with "Processing section 2 of 5" only while
   sections are being processed — no estimated percentages. The page polls every second for
   30 s, then every 3 s, and pauses while the tab is hidden. Cancel and retry are available
   when the worker allows them. "Finished" appears only after the transcript has loaded and
   validated.
4. **Your local audio.** The library lists every job with its status. Completed episodes open
   in the transcript reader, with audio streamed from the worker. **Delete** asks for
   confirmation and permanently removes that episode's audio, sections, preview transcript and
   job record — nothing else.

### Preview transcripts (mock provider)

Until real speech recognition is connected, every local transcript is placeholder text. The
reader shows a persistent banner — _"Preview transcript: This is placeholder text used to test
local audio processing. It is not a transcription of your audio."_ — and keeps Pinyin,
English, Save and Edit visible but disabled, explained by _"Learning tools become available
after Pebble creates a real transcript."_ Placeholder text never generates pinyin, never
becomes a learning item, and is never exported to Anki (both are also enforced in code, not
just in the UI).

## Local data

### What is stored, and why

Everything lives in one private directory, **`~/.pebble`** by default, outside the
repository:

| Path                                | What                                               | Why                                                      |
| ----------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| `pebble.db`                         | SQLite: episodes, jobs, chunk records, transcripts | Job status survives restarts; transcripts are kept       |
| `episodes/<id>/source.<ext>`        | The audio file you provided, byte for byte         | Playback in the reader, and reprocessing on retry        |
| `episodes/<id>/work/normalized.wav` | 16 kHz mono copy of the audio                      | The input every transcription provider receives          |
| `episodes/<id>/work/chunks/*.wav`   | Slices of the normalized audio                     | Long audio is transcribed piece by piece                 |
| `logs/worker.log`                   | Job transitions (ids, stages, error codes)         | Diagnosing failures; never contains audio or transcripts |
| `tmp/`                              | Upload spool while a file is being received        | Keeps in-flight uploads inside the private directory     |

The directory and every file in it are private to your macOS user (`0700` directories,
`0600` files). The worker never serves a file outside this directory: every path is resolved
and checked against it, and the HTTP API exposes no file paths or directory listings.

### Changing the location

```bash
PEBBLE_DATA_DIR=/Volumes/Archive/pebble npm run worker
```

Use the same `PEBBLE_DATA_DIR` for `npm run worker:doctor`. If you point it inside the
repository, `.gitignore` already excludes `.pebble/` and `*.db*` files — but keeping it
outside the repository is safer.

### Deleting Pebble's local data

- **One episode:** `DELETE /episodes/<id>` removes its audio, work files, chunks, job and
  transcript (refused while its job is queued or running — cancel first).
- **Everything:** stop the worker, then:

  ```bash
  rm -rf ~/.pebble          # or your PEBBLE_DATA_DIR
  ```

  The next start creates an empty directory. Learner data in the browser (corrections,
  learning items) is separate; clear it with **Reset demo data** in the app.

## Pipeline

```
upload ─► queued ─► probing ─► normalizing ─► chunking ─► transcribing (i / n) ─► merging ─► completed
```

| Stage          | What happens                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `probing`      | `ffprobe` checks there is an audio stream and reads the duration (limit: 4 h by default)             |
| `normalizing`  | `ffmpeg` decodes to 16 kHz mono 16-bit PCM WAV                                                       |
| `chunking`     | `silencedetect`, then cut at the silence closest to the target length; hard cut if none              |
| `transcribing` | The provider runs chunk by chunk; progress is the real count of finished chunks                      |
| `merging`      | Times are shifted to the episode, segments renumbered, and the result validated against the contract |

Only one job runs at a time; others wait in order.

### Chunking

| Setting                       | Default | Meaning                                                               |
| ----------------------------- | ------- | --------------------------------------------------------------------- |
| `PEBBLE_CHUNK_TARGET_SECONDS` | 150     | Preferred chunk length                                                |
| `PEBBLE_CHUNK_MIN_SECONDS`    | 120     | Earliest a silence may be used as a cut                               |
| `PEBBLE_CHUNK_MAX_SECONDS`    | 240     | Longest a chunk may be; a hard cut at the target if no usable silence |
| `PEBBLE_SILENCE_MIN_SECONDS`  | 0.4     | Shortest pause that counts as silence                                 |
| `PEBBLE_SILENCE_NOISE_DB`     | -35     | Level below which audio counts as silence                             |

These 2–3 minute defaults are for development. Longer chunks will be benchmarked with real
FunASR in M1 before choosing a personal-use default. Chunks are sample-exact slices of the
normalized audio: no gaps, no overlap.

### Failures

Every failure is reported as `{ stage, code, message, retryable, hint }`:

| Code                   | Retryable | Typical cause                                |
| ---------------------- | --------- | -------------------------------------------- |
| `FFMPEG_NOT_FOUND`     | yes       | FFmpeg isn't installed or not on `PATH`      |
| `UNSUPPORTED_MEDIA`    | no        | Not audio, damaged, or an unusual codec      |
| `NO_AUDIO_STREAM`      | no        | A video or container without sound           |
| `AUDIO_TOO_LONG`       | no        | Longer than `PEBBLE_MAX_AUDIO_SECONDS`       |
| `STORAGE_ERROR`        | yes       | Disk full or not writable                    |
| `PROVIDER_UNAVAILABLE` | yes       | The transcription provider isn't set up      |
| `PROVIDER_ERROR`       | yes       | The provider failed on a chunk               |
| `WORKER_RESTARTED`     | yes       | The worker stopped while the job was running |
| `CANCELLED`            | yes       | You cancelled the job                        |
| `INTERNAL_ERROR`       | yes       | Unexpected; details in `logs/worker.log`     |

### Cancel and retry: what is kept, what is redone

- **Cancel** a queued job and it never runs. Cancel a running job and it stops at the next
  safe point (between stages, between chunks, or by stopping a running FFmpeg process).
- **Retry** is allowed for retryable failures and cancellations. It always restarts from the
  **source audio**, the known-safe checkpoint:
  - **Kept:** the episode, your source audio, the job id, and the chunk records of earlier
    attempts (for diagnosis and future resume support). The attempt number goes up.
  - **Redone:** probe, normalize, chunking (the work directory is cleared first),
    transcription of every chunk, and merge.
  - **Never:** merging output from an earlier attempt, or merging an incomplete attempt. A
    transcript is written only when every chunk of the current attempt has finished.
- **Worker restarts:** a job that was running when the worker stopped becomes `failed` with
  `WORKER_RESTARTED` and waits for an explicit retry. Jobs that were still queued (never
  started) run normally when the worker starts again.

## HTTP API (localhost only)

| Method / path                      | Purpose                                                              |
| ---------------------------------- | -------------------------------------------------------------------- |
| `GET /health`                      | Worker version, FFmpeg/ffprobe, data directory, providers            |
| `POST /episodes`                   | Multipart `file`, `title`, `ownershipConfirmed=true` → `201 { job }` |
| `GET /episodes`                    | Episodes whose job completed (manifest shape)                        |
| `GET /episodes/{id}`               | One ready episode                                                    |
| `GET /episodes/{id}/audio`         | The source audio, with HTTP Range support for seeking                |
| `GET /episodes/{id}/transcript`    | The validated transcript                                             |
| `DELETE /episodes/{id}`            | Remove an episode and all its files                                  |
| `GET /jobs`, `GET /jobs/{id}`      | Job status (poll while processing)                                   |
| `POST /jobs/{id}/cancel`, `/retry` | Cancel or retry                                                      |

Errors use `{ "error": { "code", "message", "hint"? } }`. Uploads must confirm ownership
(`OWNERSHIP_NOT_CONFIRMED` otherwise), use a supported extension (`.m4a .mp4 .aac .mp3 .wav
.flac .ogg .oga .opus .webm`), and stay under `PEBBLE_MAX_UPLOAD_MB` (2048 by default).

## Security boundary

- Binds to `127.0.0.1` only; any other host (`0.0.0.0`, `localhost`, `::`, LAN addresses) is
  refused at startup.
- `Host` must be `127.0.0.1` or `localhost` (guards against DNS rebinding).
- Browser requests must come from an allowlisted origin. Defaults: `localhost` and
  `127.0.0.1` on ports `5173` (demo dev), `5175` (local-mode dev) and `4173` (preview). Override with a comma-separated
  `PEBBLE_ALLOWED_ORIGINS`; only `http://localhost:PORT` / `http://127.0.0.1:PORT` are
  accepted. Requests from other origins — including multipart form posts that skip CORS
  preflight — are rejected with `403`, as are cross-site requests without an `Origin`
  (e.g. an `<audio>` tag on another website). The web app's audio element must therefore use
  `crossorigin="anonymous"`.
- CORS echoes only allowlisted origins (never `*`) and never allows credentials.
- No interactive docs, OpenAPI schema or directory listings are exposed. The only path the
  API reports is the data folder's location in `/health` (abbreviated with `~`), so the app can
  explain data-folder problems; no other file paths appear in responses.

## Configuration reference

| Variable                          | Default                  | Notes                                     |
| --------------------------------- | ------------------------ | ----------------------------------------- |
| `PEBBLE_DATA_DIR`                 | `~/.pebble`              | See [Local data](#local-data)             |
| `PEBBLE_PORT`                     | `8790`                   |                                           |
| `PEBBLE_HOST`                     | `127.0.0.1`              | Anything else is refused                  |
| `PEBBLE_ALLOWED_ORIGINS`          | Vite dev/preview origins | Local http origins only                   |
| `PEBBLE_MAX_AUDIO_SECONDS`        | `14400`                  | 4 hours                                   |
| `PEBBLE_MAX_UPLOAD_MB`            | `2048`                   |                                           |
| `PEBBLE_FFMPEG`, `PEBBLE_FFPROBE` | `ffmpeg`, `ffprobe`      | Paths to the binaries                     |
| `PEBBLE_MOCK_DELAY_MS`            | `300`                    | Simulated time per chunk                  |
| `PEBBLE_MOCK_FAIL_AT_CHUNK`       | unset                    | 1-based chunk number to fail on (testing) |
| Chunking variables                |                          | See [Chunking](#chunking)                 |
