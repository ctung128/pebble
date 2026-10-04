# Benchmarks (M1-B)

`pebble-worker bench` measures Pebble's existing local FunASR pipeline on audio you own or are
authorized to use, on this computer. It exists to help choose, by hand:

- a personal-use target chunk length;
- whether the structural review-flag thresholds (7 s / 0.8 s / 2 s) are useful;
- whether real transcript timing and quality are good enough for learning.

It does **not** pick defaults, change settings, make accuracy claims, or publish anything. Its
numbers are local measurements on one machine.

> [!IMPORTANT]
> **Status:** B1 tooling is in place and the B2 starter runs have been made on two private
> clips. Their results stay private under `~/.pebble`; no defaults have changed.

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
npm run worker:bench -- review --run <run-id>                     # rebuild review.md only
```

Overlap experiment commands (`--overlap-ms`, `compare`, `pair`, `tally`) are described in
[Overlap experiment](#overlap-experiment-m1-b2-benchmark-only).

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
- `review --run <id>` rebuilds a run's `review.md` from its saved `transcript.json` and cut
  positions with the current selection rules. It never transcribes, loads models or uses the
  network, and it leaves `transcript.json` and `result.json` unchanged. It refuses to replace
  a list that already has ratings.

For a target T, chunks are planned with min 0.8 T and max 1.6 T — the ratios of the current
150/120/240 s default — and the default silence settings.

## Overlap experiment (M1-B2, benchmark-only)

Tests whether giving FunASR a little duplicated audio either side of each silence-based cut
recovers speech near cuts. It exists only in `bench`; the worker's jobs never overlap.

- **Model.** Cuts and chunk ownership are unchanged. With `--overlap-ms O`, each chunk's audio
  extends O/2 past each of its inner cuts (1,000 ms = 500 ms each side), clamped to the file.
  Provider times are offset by the chunk's audio start, so times stay in original-audio time.
  `--overlap-ms 0` takes exactly the existing path.
- **Resolver** (`bench/overlap.py`). Every candidate is kept unless it materially overlaps — at
  least 50% of the shorter one — an already kept candidate from the other chunk. Then the
  candidate farther from its own chunk's audio edge wins (ownership breaks ties) and the other
  is excluded as `duplicateRemoved` (same normalized text) or `conflictLoser` (different text;
  added to the private review). Unique segments in the other chunk's span are kept and counted
  as `foreignOrphanKept`. Text sharing 6+ normalized characters across a cut is only counted as
  `possibleRepeatAcrossCut`. Close calls are counted as `ambiguous`. Text is never joined,
  edited or invented; if kept segments would still overlap (beyond 100 ms), the run fails with
  `OVERLAP_UNRESOLVED` rather than trimming. Every exclusion has exactly one reason.
- **Runs.** One warm session, one run per listed overlap, a single chunk target:

  ```bash
  npm run worker:bench -- run --clip clip-b --chunk default \
    --overlap-ms 0 --overlap-ms 1000 --overlap-ms 2000
  npm run worker:bench -- compare --baseline <run-id> --run <run-id> --run <run-id> \
    --reference <other-target run-id> …
  npm run worker:bench -- pair --baseline <run-id> --run <run-id> --run <run-id>
  npm run worker:bench -- tally overlap-<time>.md
  ```

- **Compare** reads saved results only and reports, per ±4 s cut window, approximate characters
  for each variant against the baseline and against reference runs with no cut there; plus
  stability away from cuts (segments more than 10 s from a cut with the same normalized-text
  fingerprint and start/end within ±150 ms). Its numeric verdict:
  - _promising_: the variant has more characters in a majority of comparable windows, at least
    20% more in total, and valid timing (_strong pending human review_ when it also closes at
    least half the gap to the no-cut references);
  - _neutral/inconclusive_: mixed results or fewer than two windows;
  - _reject_: timing validation fails; _reject-candidate_: more than 10% fewer characters,
    pending human review.

  _Strong_ also needs fewer missing-speech ratings and no confirmed duplicate speech in the
  paired review; stability below 95% is reported alongside the verdict.

- **Paired review** (`bench pair`). A private file under `~/.pebble/benchmarks/reviews` with
  every cut window, each variant's conflict/ambiguous/repeat items (up to 10) and five controls
  away from cuts. The versions appear as X/Y/Z in a seeded random order per item; the key is a
  separate private file. Each row takes exactly one tick: replay range, text quality, missing
  speech, duplicate speech, effort (none / under 15 s / 15–60 s / over 60 s or gave up), and a
  best version per item. `bench tally` reveals the key only in its counts.

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

### Alignment diagnostic (`alignment`)

`timestamp_alignment_anomaly` is set when a sentence's text and its per-character timestamps
don't correspond. The starter runs showed it is a **private developer diagnostic, not a
learner-review signal**: it fires often, in clusters, shifts with chunk context, and showed no
timing pattern a listener would notice. It gets no review slot and no UI.

Each new run records, as numbers only: flagged sentences by reason (`count_difference`,
`timestamp_outside_segment_range`, `timestamps_out_of_order`, `malformed_timestamps`), a
signed timestamps-minus-characters histogram (≤ −3, −2, −1, +1, +2, ≥ +3), and each chunk's
text-character total against its timestamp total. Runs made before this existed have no
`alignment` block.

### CER (`cer`)

Only when a reference exists: a character error rate over letters, digits and CJK characters
(punctuation and spacing ignored), labelled with a private reference label. Synthetic speech is
labelled `synthetic-sanity`: a check that the pipeline works, not a measure of accuracy on
natural podcasts.

## Human review (`review.md`)

Up to 20 segments per run, in time order, chosen so no single signal can fill the list:

| Category                                                                            | Slots             |
| ----------------------------------------------------------------------------------- | ----------------- |
| Random controls: no review flags, not next to a cut (seeded)                        | 5, reserved first |
| Cut neighbours: the last segment before and first after each cut; forced cuts first | up to 6           |
| Long segments                                                                       | up to 3           |
| Short fragments                                                                     | up to 3           |
| Speech gaps                                                                         | up to 3           |
| Alignment diagnostic                                                                | 0                 |

Slots a category can't fill go round-robin to cut neighbours, long segments, short fragments,
speech gaps, then controls; no category takes more than 8. A segment appears once, under the
first category that picks it. Each category draws from its own seed (run seed + category), so
the lists are reproducible and one category's candidates never reshuffle another's.

Each entry has a replay command (`ffplay` on the run's `normalized.wav`) and boxes to tick:

- replay range: clean / clipped start / clipped end / extra speech
- text: fine / minor fix / major fix / missing speech
- rough correction time in seconds, and an optional note

`bench report` counts the ticks and times; it never copies the text.
