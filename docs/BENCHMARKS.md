# Benchmarks (M1-B)

`pebble-worker bench` measures Pebble's existing local FunASR pipeline on audio you own or are
authorized to use, on this computer. It exists to help choose, by hand:

- a personal-use target chunk length;
- whether the structural review-flag thresholds (7 s / 0.8 s / 2 s) are useful;
- whether real transcript timing and quality are good enough for learning.

It does **not** pick defaults, change settings, make accuracy claims, or publish anything. Its
numbers are local measurements on one machine.

> [!IMPORTANT]
> **Status: B1 (tooling only).** No benchmark has been run on private audio yet.

## Privacy

- Everything the benchmark reads or writes lives under `~/.pebble/benchmarks` (your
  `PEBBLE_DATA_DIR`): the corpus manifest, per-run results, private transcripts, review
  checklists, normalized audio and reports. Paths are checked to stay inside the data
  directory, and symlinks are refused.
- Benchmark audio, recognized text, file paths and episode ids are never committed, logged in
  repository files, copied into docs or served over HTTP. The worker's API knows nothing about
  benchmarks.
- `result.json` and `bench report` contain numbers, neutral labels and model metadata only.
  Recognized text exists only in each run's private `transcript.json` and `review.md`.
- The benchmark blocks all network access for its process, as the real-model test does.
- `bench report` writes private summaries under `~/.pebble/benchmarks/reports`; it never
  generates or edits files in this repository. Any public write-up is done by hand, with
  aggregate numbers and neutral clip descriptions only.

## Corpus

Create `~/.pebble/benchmarks/corpus.json` by hand. It may contain only these fields:

```json
{
  "schemaVersion": 1,
  "clips": [
    {
      "id": "clip-a",
      "label": "Clip A",
      "path": "/absolute/path/outside/the/repository/clip-a.m4a",
      "durationSeconds": 600,
      "rightsNote": "Recorded by me.",
      "referencePath": null,
      "difficultyNotes": "clear, single speaker"
    }
  ]
}
```

| Field             | Rule                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `id`              | `clip-a`, `clip-b`, … (unique)                                                                         |
| `label`           | neutral, such as "Clip A" — the only clip description that appears in results and reports              |
| `path`            | absolute; must exist; must be outside this repository                                                  |
| `durationSeconds` | approximate; a run is refused if the file differs by more than 10 % (catches a wrong path)             |
| `rightsNote`      | required, written by you: why you may process this audio                                               |
| `referencePath`   | optional UTF-8 text file with an **independently trustworthy** transcript (never corrected ASR output) |
| `difficultyNotes` | optional, for you                                                                                      |

Unknown fields are rejected. Error messages name the clip id, never its path or notes.

Initial corpus (B2):

- **Clip A** — 8–12 minutes, clear single-speaker or controlled conversational Mandarin.
- **Clip B** — 8–12 minutes, more natural conversation: faster, noisier or otherwise harder.

Both self-recorded or authorized; no Xiaoyuzhou or other third-party podcast audio. A third
clip only if A and B leave the decision ambiguous.

## Commands

Requires the `funasr` extra and verified models ([MODELS.md](MODELS.md)). From the repository
root (`npm run worker:bench -- …` is `pebble-worker bench …`):

```bash
npm run worker:bench -- run --clip clip-a --chunk 120 --dry-run   # validate only
npm run worker:bench -- run --clip clip-a --chunk 120 --chunk 180 --chunk 240
npm run worker:bench -- run --clip clip-a --chunk default --mode cold
npm run worker:bench -- report
```

- `run` benchmarks **one clip** at exactly the `--chunk` targets you list (seconds, 10–900, or
  `default` for the worker's current setting). There is no implicit matrix.
  - `--mode warm` (default): one process verifies and loads the models once — reported as a
    shared warm-session setup — then runs each target.
  - `--mode cold`: a fresh process per target, so the result includes process startup,
    verification, import and model load. The child process is told only the clip id.
  - `--synthetic`: invented Mandarin sentences spoken by macOS `say` instead of a corpus clip
    (a pipeline sanity check).
  - `--seed`: seeds the choice of review controls (default 7).
- `report` aggregates all runs (or `--run <id>` …) into a console summary and private
  `report-<time>.{json,md}` files.

For a target T, chunks are planned with min 0.8 T and max 1.6 T — the ratios of the current
150/120/240 s default — and the default silence settings.

## Starter protocol (B2, 7–9 runs)

```bash
npm run worker:bench -- run --clip clip-a --chunk 120 --chunk 180 --chunk 240   # 3 warm runs
npm run worker:bench -- run --clip clip-b --chunk 120 --chunk 180 --chunk 240   # 3 warm runs
npm run worker:bench -- run --clip clip-a --chunk default --mode cold           # 1 cold run
# optional, only if results need confirming: repeat the leading candidate
npm run worker:bench -- run --clip clip-b --chunk <leading> --chunk <leading>   # 1–2 runs
npm run worker:bench -- report
```

Then fill in each run's `review.md` and run `report` again to count the ratings.

## What a run records

Each run is `~/.pebble/benchmarks/runs/<run-id>/`:

| File              | Contents                                                   | Private text? |
| ----------------- | ---------------------------------------------------------- | ------------- |
| `result.json`     | all metrics below (schema: `bench/results.py`)             | no            |
| `transcript.json` | the merged transcript, as the worker would store it        | yes           |
| `review.md`       | the review checklist                                       | yes           |
| `normalized.wav`  | the 16 kHz mono audio the timestamps refer to (for replay) | audio         |

Chunk files are deleted when the run ends. Delete a run directory to remove everything from it.

### Setup and first-run overhead (`setup`)

`processStartupMs` (cold only: spawn → Pebble code running), `verificationMs` (size + SHA-256
of every model file), `importMs` (importing FunASR and PyTorch), `loadMs` (building the models).
Warm runs share one setup (`scope: shared-warm-session`); it is never added to job times.

### Job processing (`job`)

`probeMs`, `normalizeMs`, `chunkingMs` (silence detection, planning and writing chunks),
`transcriptionMs`, `mergeMs`, `totalMs`, and `realTimeFactor` = `totalMs` ÷ audio duration
(below 1 is faster than real time).

### Memory (`memory`)

One method for every run (macOS): `physFootprintJobPeakBytes` — the kernel's physical
footprint (as in Activity Monitor), sampled every 100 ms during the job;
`physFootprintLifetimePeakBytes` — the kernel's peak for the whole process;
`rssMaxBytes` — peak resident set from `getrusage`. Approximate local measurements.

### Segment and flag shape (`segments`, `chunks`, `merge`)

Segment count, duration quartiles and buckets (< 0.8 s, 0.8–2 s, 2–5 s, 5–7 s, > 7 s), each
review flag's count and share, chunk count with silence versus forced cuts, and merge checks
(ordering, overlaps, bounds).

### Chunk boundaries (`boundaries`) — objective timing only

Per cut: whether it was silence-based or forced, how many segments start or end within 300 ms
of it, the timing gap across it, and whether a segment crosses it. The benchmark never claims
text was duplicated, dropped or damaged; that takes the human review below or a reference
transcript.

### CER (`cer`)

Only when a reference exists: a character error rate over letters, digits and CJK characters
(punctuation and spacing ignored), labelled with a private reference label. Synthetic speech is
labelled `synthetic-sanity`: a check that the pipeline works, not a measure of accuracy on
natural podcasts.

## Human review (`review.md`)

Up to 20 segments per run: every segment next to a chunk cut, every flagged segment, and five
random unflagged controls (seeded). Over 20, priority is: forced-cut neighbours, timestamp
alignment anomalies, long/short flags, silence-cut neighbours, speech gaps, then controls.

Each entry has a replay command (`ffplay` on the run's `normalized.wav`) and boxes to tick:

- replay range: clean / clipped start / clipped end / extra speech
- text: fine / minor fix / major fix / missing speech
- rough correction time in seconds, and an optional note

`bench report` counts the ticks and times; it never copies the text.
