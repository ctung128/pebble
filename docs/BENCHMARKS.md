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
  least 50% of the shorter one — an already kept candidate from the other chunk. Then a
  candidate with content (any letter or digit) beats a punctuation-only one
  (`punctuationOnlyLoser`); otherwise the candidate farther from its own chunk's audio edge
  wins (ownership breaks ties) and the other is excluded as `duplicateRemoved` (same
  normalized text) or `conflictLoser` (different text; added to the private review). Results
  record `resolverVersion` (2 since the content rule; the first Clip B overlap runs used 1). Unique segments in the other chunk's span are kept and counted
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

`timestamp_alignment_anomaly` is set when a line's text and its timestamp pairs don't
correspond. It is a **private developer diagnostic, not a learner-review signal**, and gets no
review slot and no UI. The starter runs found it firing often, in clusters, shifting with chunk
context, and concluded it marked bookkeeping only. That conclusion was too strong: a later
private listening check found lines out of sync by up to ~7 s where it clustered, caused by
FunASR 1.4.16's sentence text drifting after each VAD join (ADR 0007). A flag alone still
doesn't prove a line is misaligned, but a discrepancy can come with audible misalignment.
Runs made before ADR 0007 measured FunASR's drifting `sentence_info`, not Pebble's current
lines.

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

## Speaker diarization evaluation (ADR 0009)

A bounded, benchmark-only check of CAM++ speaker labels on **one full episode you name**,
before any production speaker code. Decision record:
[ADR 0009](adr/0009-local-speaker-diarization-evaluation.md).

**Inputs, read-only.**

- An existing completed local episode (`ep-…`) and its stored ASR transcript. The database is
  opened read-only.
- Its audio: `work/normalized.wav` when it is still valid. Otherwise the source is normalized
  into a **temporary** file in the run folder, read once, and deleted before embedding starts.
- Nothing is transcribed. Transcript text, segment IDs, the database and the translation cache
  are never written.
- Requires the speaker model (`npm run worker:models -- pull --speaker`). The network is blocked
  for the whole run.

**What it does.**

1. **Windows.** Cuts every transcript line into 1.5 s windows (0.75 s shift; FunASR's
   `sv_chunk`).
2. **One embedding pass.** Embeds each window once with CAM++ on the CPU, streaming in batches.
   The embeddings exist only as one in-memory array: never written, deleted once clustering
   ends, and gone with the run's process in any case.
3. **Clustering.** Clusters the whole episode with FunASR's installed `ClusterBackend`. Each
   configuration gets a fresh copy of the same embeddings:

   | Configuration                  | Count hint | Seed (default `--seed 7`) |
   | ------------------------------ | ---------- | ------------------------- |
   | `auto`                         | none       | `seed` (7)                |
   | `auto-r2`, `auto-r3` (repeats) | none       | `seed+1`, `seed+2` (8, 9) |
   | `hint` (with `--speakers N`)   | N          | `seed` (7)                |

   All seeds are recorded (`settings.autoSeeds`, `settings.hintSeed`, each configuration's
   `seed`). NumPy's global RNG is seeded before each call; numba threading may still add
   variation, which the repeats measure.

4. **Actual counts and branch.** `result.json` records the windows actually embedded and, per
   configuration, the clustering branch that **actually ran** (`path`, recorded by wrapping the
   backend's three clusterers) next to the branch the installed thresholds predict
   (`expectedPath`). The dry run's `windowsFromLineTimes` is computed from the stored line
   times only; the run's own count is the one to trust.
5. **Line labels.** Labels each line `S1`, `S2`, … by majority, and flags it `mixed` when a second
   speaker holds at least 2 windows and 25% of them. Noise windows (`-1`) never vote.
6. **Review sample.** Picks 40–60 lines (default 50, seeded) for a **blind** review; see
   "Sampling and weighting" below.

```bash
cd services/worker
.venv/bin/pebble-worker bench diarize --episode ep-… --dry-run           # counts only
.venv/bin/pebble-worker bench diarize --episode ep-… [--speakers N] [--deadline-minutes 30]
#   then fill in ~/.pebble/benchmarks/diarize/<run>/review.md by listening
.venv/bin/pebble-worker bench diarize-score --run <run>                  # numbers only
```

### Deadline and cleanup

The run is in a child process with a finite wall-clock deadline: 30 minutes by default,
`--deadline-minutes` from 5 to 60. The deadline covers everything: normalizing, model load,
embedding, clustering and writing.

- **Cooperative stop.** The child checks the deadline between steps, between embedding batches
  (64 windows) and between clustering configurations.
- **Hard stop.** A single clustering call can't be interrupted. If the child is still running
  60 s after the deadline, or the command is interrupted (Ctrl+C), the parent kills it and
  cleans up itself.
- **Success.** The folder holds only `result.json`, `key.json` and `review.md`. No temporary
  audio or embeddings remain.
- **Timeout, failure, interruption or kill.** Every file the run wrote is deleted (including
  temporary audio), leaving a numbers-only `result.json` with `status` (`timed_out`,
  `failed`, `interrupted`, `killed_at_deadline`), the stage reached and timings so far. Nothing
  outside the run folder is touched.

### Sampling and weighting

Every line belongs to exactly one stratum (first match wins):

| Stratum      | Rule                                                                                                  | Quota of the sample |
| ------------ | ----------------------------------------------------------------------------------------------------- | ------------------- |
| `short`      | under 1.5 s (duration only)                                                                           | about 20%           |
| `transition` | `auto`'s speaker differs from the previous line's                                                     | about 24%           |
| `difficult`  | mixed or unassigned in any configuration, or `auto` disagrees with a repeat or the hint after mapping | about 20%           |
| `spread`     | everything else                                                                                       | the rest            |

- **How lines are drawn.** Within `short`, `transition` and `difficult`, lines are drawn at
  random. `spread` lines are drawn one at random per equal slice of the episode's spread lines,
  so the whole timeline is covered. A stratum smaller than its quota is taken whole, and the
  shortfall is filled at random from the remaining lines, each labelled with its own stratum.
  `key.json` records every line's stratum and the stratum sizes.
- **Why weighting is needed.** Short, transition and difficult lines are deliberately
  **oversampled**, and `transition` and `difficult` are defined by the model's own output. The
  raw sample mix therefore differs from the episode's. The raw accuracy can differ from the
  episode's in either direction; no direction is assumed.
- **Assumptions behind `spread`.**
  - `spread` lines are drawn by a time-stratified (systematic) design: the stratum's lines in
    time order are cut into as many equal slices **by line count** (not duration) as its quota,
    and one line is drawn at random from each slice.
  - This covers the whole timeline. The estimate nonetheless treats the draw as a simple random
    sample of the stratum, which holds only if accuracy doesn't vary in step with the slicing.
  - Random shortfall fills (when a stratum is smaller than its quota) mix a second design into
    some strata.
  - The other strata are simple random draws within the stratum.
- **What the score reports:**
  - `episodeEstimate`, **exploratory** (each part carries `"status": "exploratory"`). Each
    stratum's accuracy is weighted by that stratum's share of the episode's lines, computed
    separately for all, long and short lines. It comes with an approximate normal 95% interval
    (finite-population correction; also exploratory) and `populationCovered`, the share of the
    episode in strata with at least one answered line. The proposed 90% target is compared
    against the long-line `episodeEstimate`. With roughly 50 reviewed lines it is a rough
    indication, not a measurement.
  - **Support per stratum** (`byStratum`):
    - `inEpisode`: lines in the episode;
    - `picked`: lines picked;
    - `speakerAnswered`: lines with a speaker answer;
    - `unsureOrBlank`: lines left unsure or blank;
    - `unassigned`: answered lines the configuration left without a speaker;
    - the stratum's raw accuracy, with its Wilson interval.
  - **Unassigned lines, explicitly:**
    - `unassigned`: answered lines with no predicted speaker, counted as wrong;
    - `unassignedInEpisode`: every line of the episode with no predicted speaker.
  - The raw sample figures (`all`, `long`, `short`, with Wilson intervals), for diagnosis.
- **Remaining biases:**
  - speakers are mapped one-to-one to your letters using the reviewed lines themselves, so every
    accuracy is somewhat optimistic;
  - strata with few answered lines give wide or (when all right or all wrong) zero-width
    intervals;
  - mixed-flag counts are raw sample counts, with mixed lines oversampled.

### The review sheet and run folder

**The review sheet** (`review.md`, private: it contains transcript text and local paths).

- **Header:** enter the number of distinct speakers in the whole episode.
- **Each line:**
  - replay it from the episode's own audio, also with 3 s of lead-in;
  - tick one speaker (`A`–`F` used consistently, `other`, `unsure`);
  - tick one turn answer (`one speaker`, `two or more`, `unsure`).
- **Blind:** no predicted label, flag, stratum or selection reason appears on the sheet.

**Run folder** `~/.pebble/benchmarks/diarize/<UTC time>-<episode>/`:

| File          | Contents                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `result.json` | numbers only: status, windows actually embedded, per configuration (seed, hint, actual and expected branch, speakers, noise windows, minor clusters, mixed and unassigned lines, repeat agreement), stratum sizes, timings, memory, versions, settings |
| `key.json`    | per line: segment ID, times, stratum, label and mixed flag per configuration; the review picks. No text.                                                                                                                                               |
| `review.md`   | the blind sheet (text)                                                                                                                                                                                                                                 |
| `score.json`  | after review; numbers only                                                                                                                                                                                                                             |

**Report** (`diarize-score`), with each part reported separately for `auto` and `hint`:

- **Speaker count:** reviewed vs predicted, the signed error, and minor clusters. Leave the
  header's whole-episode count blank if you aren't confident; the comparison is then marked
  omitted, never guessed.
- **Dominant-line accuracy:**
  - exploratory `episodeEstimate` for all, long (≥ 2 s) and short lines;
  - raw sample figures with Wilson intervals;
  - per-stratum support and accuracy;
  - unassigned lines, both reviewed and across the episode.
- **Mixed-flag quality:** true and false positives and negatives, precision and recall against
  your `two or more` ticks. A flag estimates more than one turn; it is not verified overlap.
- **Performance:** peak memory and minutes per audio hour.
  - `primaryProcessingMs` covers the primary configuration: audio read, model load, the one
    embedding pass, `auto` clustering, and `hint` clustering if run.
  - `evaluationOverheadMs` is the repeat clusterings.
  - `benchmarkMeasuredMs` is both added together.
- **Proposed targets** (labelled _proposed, not established_):
  - ≥ 90% long-line `episodeEstimate` (exploratory);
  - ≤ 5 min per audio hour;
  - ≤ 2 GB peak memory.

### Targeted check of unmatched clusters (diagnostic)

`bench diarize-targeted --run <run>` follows a scored review. It runs no inference, reads no
audio samples, and neither opens the database nor reads transcript text.

- **Which clusters:** those the one-to-one matching left without a reviewer letter.
- **Which lines:** up to 5 not-yet-reviewed lines per cluster, one at random per equal slice of
  the cluster's remaining lines in time order.
- **The sheet** (`targeted-review.md`) is blind: times, segment IDs and replay commands only;
  no cluster or predicted speaker. Each line gets one answer: `A`, `B` (the main review's
  voices), `another voice` or `unsure`. The key is `targeted-key.json`; nothing is ever
  overwritten.
- **Scoring:** `bench diarize-targeted --run <run> --score` counts answers per cluster
  (`targeted-score.json`). It answers whether the small clusters sound like A/B or another
  voice. It is not a representative accuracy estimate and never updates the main score.

**Bounds.**

- One episode and one run (plus the optional hint configuration in the same run), within the
  deadline.
- No new corpus, no defaults changed, no tuning loop.
- A second run, a different episode or changed settings each need approval.
