# Local mode: the Pebble worker

Local mode turns audio **you own or are authorized to use** into a timestamped transcript on
your own computer. A small Python worker does the processing; the Pebble web app talks to it
over `127.0.0.1` only. Nothing is uploaded to the internet.

> **Status: M1-A3.** The worker, its job pipeline, the mock provider, the web app's local mode
> and the **FunASR provider** are built. FunASR runs only when selected
> (`npm run worker:funasr`); `npm run worker` still uses the mock. See
> [MODELS.md](MODELS.md) for setup, models and the provider's rules.

> [!IMPORTANT]
> **Current limitations:**
>
> - With the default `npm run worker`, transcripts are **mock placeholder text** (such as
>   `（模拟转写）第 1-1 段`), not recognized speech. The mock never listens to the audio.
> - With `npm run worker:funasr`, the local app creates real transcripts. Pinyin, editing,
>   saving and Anki export work; English stays hidden until a local translation provider
>   exists.

Pebble starts at a local audio file you choose. It does not fetch, download or scrape audio
from URLs or apps, and it does not work around any platform's content protections.

## Quick start (pilot testers)

Testers: start with the plain-language [pilot guide](PILOT_GUIDE.md).

From the Pebble folder, four commands. Each explains what it will do; nothing is installed or
downloaded without asking first.

```bash
npm run pebble:doctor            # read-only check: what's ready and the one next step for each problem
npm run pebble:setup             # guided: asks before installing app packages, the speech
                                 # environment, and before the one-time ~1.3 GB model download
npm run pebble:start             # starts Pebble; then open http://localhost:5175
npm run pebble:stop              # stops a Pebble started with pebble:start (or press Ctrl+C there)
npm run pebble:doctor -- --verify   # also checks every speech model file (takes a few seconds)
```

- **Setup never installs Node.js, uv or FFmpeg.** It prints the command for you to run yourself.
  The speech environment goes in `services/worker/.venv`; downloads are kept under `~/.pebble`
  (including Python 3.12, only if uv can't find one — setup says so before it happens). If you
  decline a step, setup stops and tells you whether anything was changed.
- **`pebble:start`** prints "Pebble is starting: open http://localhost:5175" as soon as the
  worker answers; the app then shows "Checking local speech models…" until they're ready. It
  runs in the foreground: Ctrl+C stops Pebble. Its technical log is
  `~/.pebble/logs/pebble-start.log`.
- **Ports.** The worker uses 127.0.0.1:8790 and the app 5175. If Pebble is already running,
  start says so instead of starting a second copy. If another program uses 8790, Pebble never
  touches it; start on another port with `PEBBLE_PORT=8791 npm run pebble:start` (the app is
  pointed at that port automatically).
- **Stopping.** `pebble:stop` only stops the worker that `pebble:start` launched: the worker's
  `/health` must report the same random `instanceId` that start recorded in
  `~/.pebble/run/pebble.json` (plus the same PID, port and version). It asks politely and never
  force-kills; anything it can't identify is left alone with an explanation.
- If the worker stops while a transcript is being made, that job shows as failed with a
  **Retry** option when Pebble starts again.

The developer commands below still work as before.

## Requirements

- macOS or Linux, Python 3.12+, [uv](https://docs.astral.sh/uv/), and FFmpeg (`ffmpeg` and
  `ffprobe` on `PATH`).
- No GPU, accounts or API keys. The mock worker needs no models.
- Optional, for real speech recognition (M1): the worker's `funasr` extra (~231 MB download,
  ~0.9 GB installed) and the three pinned models (~1.30 GB). See [MODELS.md](MODELS.md).

## Commands

From the repository root:

```bash
npm run worker:doctor   # check Python, FFmpeg, the data directory, database and provider
npm run worker          # start on http://127.0.0.1:8790 (Ctrl+C to stop), mock provider
npm run worker:funasr   # the same, with FunASR speech recognition (see MODELS.md)
npm run test:worker     # pytest + ruff
npm run worker:models -- list|verify|pull   # pinned speech models (see MODELS.md)
```

`uv` creates the worker's private environment in `services/worker/.venv` on first use, using
your installed Python. (Set `UV_PYTHON_DOWNLOADS=never` if you want uv to refuse to download a
Python build.) The npm scripts set `UV_CACHE_DIR=~/.pebble/uv-cache`, so packages uv downloads
for Pebble are cached inside Pebble's data directory; set it yourself when you run `uv`
directly, for example `UV_CACHE_DIR=~/.pebble/uv-cache uv sync --extra funasr` in
`services/worker`.

Pebble defaults to 127.0.0.1:8790 to avoid conflict with AnkiConnect, which commonly uses port 8765. Before starting, the worker checks the port: it counts as free only if nothing accepts a connection on it and it can be bound the way the server binds it, so connections left over from a previous run don't block a restart. If a Pebble worker is already there, it says so; if another program is, it says so and exits — choose another port with `PEBBLE_PORT`.

## Using local mode in the browser

**File names stay private.** The reader and library show your **Episode title** and "Local
audio", never the audio's file name. The title starts as the file name and is editable before
processing, and can be renamed later with the pencil beside the title (on the episode page,
or on the processing page for a failed or cancelled episode; `PATCH /episodes/{id}`, 1.7) once
the episode isn't processing. Renaming changes only that title: the audio file, its name and location, and the
transcript are untouched, and learning items already saved keep the title they were saved
with. The worker keeps the original file name only in its private database and
never returns it from the API or writes it to its log.

Local mode is a separate build of the web app; the public demo never contains it. In two
terminals, from the repository root:

```bash
npm run worker          # the worker on 127.0.0.1:8790
npm run dev:local       # the app in local mode on http://localhost:5175
```

Open **http://localhost:5175**. With `npm run worker:funasr` instead of `npm run worker`, the
same flow creates real transcripts: **Create a transcript locally** → **Create transcript** →
**Creating your transcript** → **Open transcript**. Just after the worker starts, the app shows
"Checking local speech models…" for a few seconds while the worker verifies the model files. (Port 5175 lets local mode run alongside the demo dev server
on 5173; both are in the worker's default origin allowlist.)

1. **Worker status.** The app calls `/health` first and offers uploads only when the worker's
   one provider is ready: "Local worker is ready." (mock) or "Local transcription is ready."
   (FunASR). Otherwise it explains what to fix — the worker isn't running (`npm run worker`,
   or `npm run worker:funasr`), FFmpeg is missing (`brew install ffmpeg`, then
   `npm run worker:doctor`), the app and worker versions don't match, the data folder isn't
   accessible (with its path and the worker's hint), the worker runs a provider this app
   doesn't know ("Pebble's local worker configuration does not match this app."), FunASR needs
   setup or couldn't load (with the worker's one-line hint), or the worker refused this page's
   address — and re-checks every few seconds (every second while models are being checked).
2. **Process audio locally.** Choose a file (M4A, MP3, WAV, FLAC, OGG/Opus, WebM or AAC, up to
   2 GB), adjust the title (prefilled from the filename), confirm _"I own this audio or am
   authorized to process it. Pebble processes it only on this computer."_, and choose **Run
   processing preview**. Upload progress shows real bytes sent.
3. **Progress.** Stages are shown as they happen, with "Processing section 2 of 5" only while
   sections are being processed — no estimated percentages. The page polls every second for
   30 s, then every 3 s, and pauses while the tab is hidden. Cancel and retry are available
   when the worker allows them. "Finished" appears only after the transcript has loaded and
   validated.
4. **Library.** The library lists every job with its status. A finished episode's row shows
   its date, length and line count (a preview shows no line count) and opens the transcript
   reader, with audio streamed from the worker. **Delete** asks for
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

## Speech recognition with FunASR (M1)

```bash
npm run worker:funasr     # PEBBLE_PROVIDER=funasr, with the funasr extra
```

The provider is chosen only by `PEBBLE_PROVIDER` (`mock`, the default, or `funasr`); an
unknown value stops the worker at startup, and Pebble never falls back from FunASR to the
mock. On the first job the worker verifies the model files and loads them (CPU only), which
takes noticeably longer than later jobs. Each recognized sentence becomes one transcript line
with its own start and end time; `confidence` stays `null`. FunASR transcripts also carry
structural review flags (long line, short fragment, long gap, timestamp mismatch) — internal
evidence for review, not confidence, and not shown to learners. Details, thresholds and every
failure state: [MODELS.md](MODELS.md#the-funasr-provider).

Transcription uses three pinned FunASR models: SeACo-Paraformer (speech), FSMN-VAD
(voice activity) and CT-Transformer (Mandarin punctuation). [MODELS.md](MODELS.md) has the
details; in short:

- The manifest in `services/worker/src/pebble_worker/models/manifest.py` is the source of
  truth: full model IDs at exact tags, with the size and SHA-256 of every runtime file. Pebble
  never uses a floating "latest" model reference.
- The FunASR toolkit is MIT-licensed. Every selected model card reports **Apache-2.0**. The
  selected cards do not link the FunASR Model Open Source License, so Pebble records
  Apache-2.0 as the applicable license for these exact checkpoints.
- Attribution keeps the full original model names and their provenance: Alibaba Tongyi Lab,
  published by the `iic` organization on ModelScope.
- Weights are local-only: downloaded by you with `npm run worker:models -- pull` into
  `~/.pebble/models`, and never committed, bundled into the public demo, or served by the
  worker.

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
| `models/iic/<name>/`                | Pinned speech model files (after `models pull`)    | Local transcription; never committed, bundled or served  |
| `models/.modelscope/`               | ModelScope's settings and session directory        | Keeps the model hub's state out of your home directory   |
| `uv-cache/`                         | uv's package download cache                        | Keeps Pebble's package downloads in one removable place  |

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
  rm -rf ~/.pebble               # or your PEBBLE_DATA_DIR
  rm -rf services/worker/.venv   # optional: the isolated worker Python environment
  ```

  `rm -rf ~/.pebble` removes Pebble's audio, chunks, database, logs, downloaded models,
  ModelScope state, benchmark artifacts and the uv cache. The worker environment lives in the
  repository at `services/worker/.venv` and is removed separately. The next start creates an
  empty directory. Learner data in the browser (corrections,
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
| `PROVIDER_ERROR`       | yes¹      | The provider failed on a chunk               |
| `NO_SPEECH_DETECTED`   | no        | FunASR found no speech in the whole audio    |
| `WORKER_RESTARTED`     | yes       | The worker stopped while the job was running |
| `CANCELLED`            | yes       | You cancelled the job                        |
| `INTERNAL_ERROR`       | yes       | Unexpected; details in `logs/worker.log`     |

¹ Except when FunASR's output can't be turned into timed lines without guessing (for example
a sentence without an end time): that `PROVIDER_ERROR` is not retryable. See
[MODELS.md](MODELS.md#health-and-failures) for every FunASR failure state.

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
| `PATCH /episodes/{id}`             | `{ "title" }` → `{ job }` (1.7): rename the user-facing title only   |
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
| `UV_CACHE_DIR`                    | `~/.pebble/uv-cache`     | Set by the npm worker scripts             |
| `PEBBLE_PORT`                     | `8790`                   |                                           |
| `PEBBLE_PROVIDER`                 | `mock`                   | `mock` or `funasr`; no fallback           |
| `PEBBLE_REVIEW_LONG_SEGMENT_MS`   | `7000`                   | FunASR review flag threshold              |
| `PEBBLE_REVIEW_SHORT_FRAGMENT_MS` | `800`                    | FunASR review flag threshold              |
| `PEBBLE_REVIEW_SPEECH_GAP_MS`     | `2000`                   | FunASR review flag threshold              |
| `PEBBLE_HOST`                     | `127.0.0.1`              | Anything else is refused                  |
| `PEBBLE_ALLOWED_ORIGINS`          | Vite dev/preview origins | Local http origins only                   |
| `PEBBLE_MAX_AUDIO_SECONDS`        | `14400`                  | 4 hours                                   |
| `PEBBLE_MAX_UPLOAD_MB`            | `2048`                   |                                           |
| `PEBBLE_FFMPEG`, `PEBBLE_FFPROBE` | `ffmpeg`, `ffprobe`      | Paths to the binaries                     |
| `PEBBLE_MOCK_DELAY_MS`            | `300`                    | Simulated time per chunk                  |
| `PEBBLE_MOCK_FAIL_AT_CHUNK`       | unset                    | 1-based chunk number to fail on (testing) |
| Chunking variables                |                          | See [Chunking](#chunking)                 |
