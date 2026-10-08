# ADR 0009 — Local speaker diarization with CAM++

**Status:** Accepted (2026-10-07). CAM++ is approved for an **experimental first version** of
automatic speaker labels, after one bounded evaluation (results and limits below). No further
benchmark runs are required now.

- **First-version scope:**
  - separate local, whole-episode diarization;
  - existing episodes processed while their audio remains;
  - generic episode-local speaker IDs;
  - rename speakers;
  - reassign a line;
  - optional manual merge;
  - mark a detected cluster or a single line as not-a-speaker/unassigned.
- **Out of scope:** automatic small-cluster merges, automatic music classification, mixed-line
  warnings, line splitting, cross-episode voice recognition.
- **Must hold:**
  - transcript text, segment IDs, learner edits, saved snapshots, and English
    translation/cache identity are preserved;
  - speaker labels never become part of the source text sent to DeepL;
  - transcription and translation keep working when the speaker model is missing or a speaker
    run fails.
- **Done so far:**
  - the pinned model download;
  - the benchmark harness;
  - the synthetic-tested diarization core (`pebble_worker/speakers`).
- **Implemented for review (not activated, no UI):**
  - the child-process runner and child;
  - additive migration 3;
  - the speaker store;
  - contract 1.9 (advertised);
  - routes;
  - scheduling on the single runner;
  - the health capability.
- **Not done yet:** UI, a real CAM++ smoke run inside the sandbox, activation and commits.
  Automatic runs after transcription are **not** planned for the first version.

## Routes and scheduling (contract 1.9)

- **Routes.** `POST /episodes/{id}/speakers`, `GET /episodes/{id}/speakers`,
  `PUT /episodes/{id}/speakers/corrections` and `POST /episodes/{id}/speakers/runs/{runId}/cancel`
  sit behind the existing Host, Origin, loopback and CORS checks.
  - Request handlers validate and claim work atomically. They never load the model, read or
    normalize audio, or run inference.
  - Errors use fixed codes and copy (CONTRACT.md).
- **Scheduling.** Speaker runs share the worker's single runner, so a speaker run and a
  transcription job never overlap.
  - Whenever a transcription job is waiting, it goes before the next speaker run. A speaker run
    already in progress isn't interrupted.
  - On shutdown, waiting transcription jobs drain as before, but no new speaker run starts.
- **Startup.**
  - Runs left running are failed with `WORKER_RESTARTED` and never re-run silently; a later
    explicit new run is allowed.
  - Queued runs resume, oldest first.
  - Only verifiably speaker-owned scratch folders are removed: exact `speakers-XXXXXXXX` names,
    real directories directly inside `<data>/tmp`, owned by this user, never followed through a
    symlink.
- **Deletion.** Deleting an episode first cancels its speaker work, then removes its files, then
  its rows. A child that is reading the audio is stopped, and any late result is discarded.
- **Health.** `speakers.state` comes from file presence and sizes plus the sandbox tool's
  presence. Health never hashes or loads the model, and the field never changes `status`.

## Amendment (2026-10-07): child-process runs and correction storage

**Child-process execution.** Production runs reuse the benchmark's isolation pattern
(`pebble_worker/speakers/runner.py`, `child.py`, `isolation.py`).

- **Parent.** The parent queues work and persists results. It never imports model code and never
  reads the child's output streams.
- **Enforced network boundary (OS).** On macOS the child is launched as
  `/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' …`.
  - The tool is called by absolute path and needs no privileges.
  - The kernel denies every network operation to the child **and all its descendants**,
    Python or native: TCP, UDP, Unix-domain sockets, name lookups through system services.
  - Files (model weights, scratch, audio) stay usable.
- **Proof before model code.** Before importing any model code, the child proves the boundary:
  a 1 s TCP connect to 127.0.0.1:9 (no listener, no payload) must fail with EPERM, not
  "connection refused". Only then does it install the Python-level guard, as defense in depth.
- **No fallback.** On any other platform, if the tool is missing, or if the proof fails, the run
  fails with `NETWORK_ISOLATION_FAILED`. The child is never started unwrapped.
- **Limits.**
  - `sandbox-exec` is deprecated by Apple, though functional on macOS 26.5.1. If it's removed,
    speaker runs fail safely; transcription and DeepL are unaffected.
  - Linux and Windows have no boundary yet.
  - Unix-domain sockets are denied too, so a library that needs them would fail the run rather
    than bypass the boundary.
- **Environment.**
  - The child gets a minimal allowlisted environment: no API keys, tokens, proxies or other
    inherited credentials.
  - `HOME`, `TMPDIR`, numba and ModelScope state all point into a private, run-local scratch
    folder under `<data>/tmp`.
  - That folder is deleted on every exit path, and leftovers from a crashed worker are removed
    at start. There is **no permanent numba cache**.
- **Deadline and termination.**
  - The child's deadline is 10 min plus 15 min per audio hour, capped at 70 min.
  - The child stops itself at the deadline, and also if the worker that started it goes away.
  - The parent sends SIGTERM to the child's **process group** after the deadline plus a 10 s
    grace period, or at once on cancel, then SIGKILL; every wait is bounded. Descendants in the
    group are stopped with it. A descendant that deliberately starts its own session would
    escape the kill, though not the network sandbox.
- **Results.** Only fixed codes and validated numbers are kept. Transcription and DeepL never
  depend on a speaker run.

**Run lifecycle.**

- **Queued at restart:** resumed, oldest first. They never started, so nothing is duplicated.
- **Running at restart:** failed with `WORKER_RESTARTED` and never re-run silently; the learner
  can start a new run.
- **Episode deletion:** the episode's queued and running runs are cancelled first. The parent
  polls the run's status, stops the child, and discards any late result. Database rows cascade.
- **Transcript replaced during a run:** the result is not published. The run fails with
  `TRANSCRIPT_CHANGED`, and runs for an older transcript are never `current`.
- **Failed, cancelled or stale re-detection:** the previous successful run stays `current`,
  unless the transcript itself changed.

**Correction storage.** This supersedes the earlier proposal to store speaker edits in the
browser's IndexedDB (`speakerEdits`).

- For local transcripts, corrections live in the **worker database** (`speaker_corrections`).
  Each set belongs to one episode's **completed** run, is accepted only for that episode's
  current run, and is never carried to a new run.
- Browser state for speakers is transient.
- Original assignments (`speaker_assignments`) are never edited and stay available separately
  from the corrected (effective) assignments.
- Saved learning-item snapshots are unchanged; they don't include speakers.
- **Names** are user-entered display text, not transcript text: 1–60 code points, at most 200
  per run. They are never logged, never echoed in errors, and never sent to DeepL.
- **Corrections** are bounded (200 names, merges and not-a-speaker entries; 20,000 line
  reassignments) and validated in a fixed order. Merge cycles and chains, merged-and-hidden
  conflicts, and lines reassigned to hidden speakers are rejected.
- **Effective assignments** only ever name visible, canonical speakers: never a merged-away or
  not-a-speaker cluster. Original assignments are kept unchanged beside them.

## Context

Long (hour-plus), multi-speaker Mandarin podcasts need speaker labels, and assigning every line
by hand is not acceptable. FunASR's output in Pebble has no speaker information: the provider
never loads a speaker model, and `speaker` is always `null` (MODELS.md). The contract, merge
and reader already carry an opaque `speaker` field.

FunASR's built-in path (`AutoModel(spk_model=…)`) is not a fit:

- it clusters inside one `generate()` call, which in Pebble is one ~150 s chunk, so `Speaker 1`
  would restart in every chunk;
- it attaches speakers to `sentence_info`, which Pebble deliberately doesn't use (ADR 0007).

## Decision

**Model.** `iic/speech_campplus_sv_zh-cn_16k-common` @ `v2.0.2` (CAM++, Mandarin, 16 kHz, 192-dim
embeddings), Apache-2.0 by its ModelScope card. Three runtime files (28,037,453 bytes), pinned
by size and SHA-256 in `SPEAKER_MODELS` (kept apart from the required `MANIFEST`), downloaded
by `npm run worker:models -- pull --speaker`. No new Python packages: FunASR, scikit-learn,
SciPy and umap-learn are already in the `funasr` extra.

**Architecture (for the evaluation, and the intended production shape).**

- A separate local step **after** transcription, never inside it. It reads the audio and the
  stored transcript's line times; it never changes transcript text, segment IDs, the transcript
  body or the translation cache (which keys on segment ID and text fingerprint).
- **One clustering over the whole episode**, not per ASR chunk: every line is cut into FunASR's
  own speaker windows (1.5 s, 0.75 s shift), every window is embedded, and all windows are
  clustered once with FunASR's installed `ClusterBackend`.
- Each line gets the speaker holding most of its windows. A line is **mixed** when a second
  speaker holds at least 2 windows and 25% of them: an estimate of more than one turn, **not**
  verified overlapping speech. Lines are never split (IDs and text stay as they are).
- **Generic, episode-local IDs** (`S1`, `S2`, … in order of first appearance). Names are
  user-entered labels on top of those IDs. No cross-episode recognition, no voice-enrollment
  database, no stored voiceprints.
- **Embeddings stay in memory** and are discarded after clustering. No retention need has been
  shown; persisting them needs its own justification and approval.
- Audio never leaves the computer. The only network use is the one-time pinned model download;
  the benchmark blocks the network for its whole process.

**Optional, never required.** Missing or unverified speaker weights don't affect health,
`pebble:doctor`, `pebble:setup`, startup, transcription or translation: none of them reads
`SPEAKER_MODELS`. Only the evaluation (and later the speaker step) refuses to run without them.

**Existing episodes** can be evaluated (and later labeled) without re-transcription while their
audio is still in the data directory: the step needs only the audio and the stored line times.

**UI direction (later, separately approved):** a letter beside each line (the existing speaker
slot) and an accessible legend where names are edited. Basic per-line reassignment first;
merge/add-speaker controls are scoped after seeing the evaluation's real errors.

## Verified facts (2026-10-07)

- **Revision:** tags `v1.0.0`, `v2.0.0`, `v2.0.2` (latest, 2024-01-15). At `v2.0.2` and current
  `master`, `campplus_cn_common.bin`, `config.yaml` and `configuration.json` are byte-identical
  (`master` adds `requirements.txt` and changes the README only).
- **License:** card metadata and README front matter say `Apache License 2.0`. The card doesn't
  link the FunASR Model Open Source License, and there's no separate license file. The README
  says training used a large Chinese speaker dataset (~200k speakers) without naming it.
- **Files:** `configuration.json` (581 B), `config.yaml` (537 B), `campplus_cn_common.bin`
  (28,036,335 B); hashes are in `manifest.py`. README, example WAVs and images aren't fetched.
- **Download:** pulled through the existing tooling into `~/.pebble/models`; all three files
  verified (size + SHA-256), private permissions, nothing else in the folder.
- **Compatibility (installed `funasr==1.4.16`, read from source, not run):** `config.yaml` names
  `model: CAMPPlus` with `WavFrontend` at 16 kHz, both registered in the installed package;
  `configuration.json`'s `file_path_metas` maps `init_param` to the `.bin`. A local folder is
  loaded without a hub call. Remote code is imported (and `requirements.txt` installed) only
  with `trust_remote_code=True`, which Pebble never sets; the pinned tag has no
  `requirements.txt`. Weights load with `torch.load` without an explicit `weights_only`, so
  torch 2.11's tensors-only default applies.

## Installed clustering behavior (`funasr/models/campplus`, 1.4.16)

| Windows  | No count hint                                                                             | With count hint `k`                                 |
| -------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------- |
| < 20     | every window is one speaker                                                               | the same                                            |
| 20–2,047 | spectral: cosine affinity, p-pruning (`pval` 0.022), eigengap over 1–15 speakers, k-means | spectral with `k`                                   |
| ≥ 2,048  | UMAP (60 dims, 20 neighbours) + HDBSCAN (min cluster 10)                                  | k-means on normalized embeddings (`random_state=0`) |

Without a hint, clusters whose centroids have cosine similarity ≥ 0.78 are then merged.
Which branch an episode takes depends on its **actual window count**, which this ADR
doesn't assume. Each run records the windows it embedded and the branch that actually ran
(BENCHMARKS.md). Only full-hour episodes with dense speech are likely to reach the
2,048-window branches, and that is to be confirmed by the run, not inferred from duration.

Limitations found in the installed source:

- **Noise becomes a fake speaker in FunASR's own pipeline.** HDBSCAN labels some windows `-1`;
  `merge_by_cos` leaves them alone, then `correct_labels` gives `-1` its own speaker ID. The
  benchmark keeps `-1` out of line votes and reports it as `noiseWindows`.
- **All-noise failure.** If HDBSCAN labels every window `-1`, `merge_by_cos` fails on an empty
  stack. The benchmark records a clustering failure for that configuration.
- **Not deterministic by default.** Spectral's k-means and UMAP pass no `random_state`. The
  benchmark seeds NumPy's global RNG and runs the auto configuration with three distinct,
  recorded seeds (`seed`, `seed+1`, `seed+2`) to measure stability (numba threading may still
  vary).
- **Short lines.** Lines under 1.5 s are zero-padded to one full window. Backchannels (嗯, 对)
  are likely to be weak.
- **Resolution and overlap.** Speaker changes resolve to about 0.75 s; there is no
  overlapped-speech detection.
- **Hint ceiling.** The eigengap search stops at 15 speakers.

## Evaluation (one bounded run, then a go/no-go)

The run has a finite deadline (30 minutes by default, 5–60) enforced by a parent process
that kills an overrunning child. Any stop removes every partial file and leaves a status-only
`result.json`. Because the sample deliberately oversamples some kinds of line, an
**exploratory** episode-level accuracy weights each review stratum by its share of the
episode, alongside per-stratum support counts and explicit unassigned lines. Its sampling
assumptions are in BENCHMARKS.md.

See [BENCHMARKS.md § Speaker diarization evaluation](../BENCHMARKS.md#speaker-diarization-evaluation-adr-0009).
**Proposed** targets, not established performance:

- at least 90% dominant-speaker accuracy on lines of 2 s or longer (the exploratory
  episode-weighted estimate);
- at most 5 minutes of processing per audio hour;
- at most 2 GB peak memory.

## Evaluation summary (2026-10-07; exploratory)

One bounded run on one long, private, user-selected episode, followed by a blind review of
about 50 lines and a short targeted check of the small clusters. The exact figures are kept in
the user's private diagnostics, not in the repository.

- **Decision:** CAM++ is good enough for an **experimental** first version that you correct by
  hand, not for unattended use.
  - The two main voices were assigned consistently on the reviewed lines.
  - Repeated clustering with different seeds gave the same result.
- **What went wrong:**
  - A few lines went to extra small clusters. One looked like a split-off of a main voice, which
    supports offering an **optional, manual merge**, not certainty about every line in it.
  - Another small cluster was mostly non-speech, as judged by the listener. Identifying it is a
    **human-reviewed correction**; Pebble doesn't classify music or non-speech automatically.
  - The misses fell in these small clusters, not in confusion between the main voices.
- **Mixed-line flags:** the evidence was too thin to support warnings, so mixed-line warnings
  stay out of scope.
- **Lines with more than one speaker:** a line where the reviewer heard two speakers was treated
  as multi-speaker and ambiguous for dominant-speaker scoring. The reviewer's answer was recorded
  as given and never altered.
- **Performance** (Apple M3 Pro, CPU only):
  - processing was slower than the proposed 5 minutes per audio hour, and embedding dominated;
  - peak memory stayed under the proposed 2 GB.
- **Limits:**
  - one episode and a few dozen reviewed lines;
  - speakers were matched to the reviewer's labels on the reviewed lines themselves, which is
    optimistic;
  - the weighted estimate assumes simple random sampling within categories that were partly
    drawn by time slices;
  - the whole-episode speaker count wasn't provided;
  - there are no conclusions about other episodes, speakers or recording conditions.

## Consequences

- One small pinned model is downloaded on request; `models list|verify|pull --speaker` manage
  it. Transcription setup is unchanged (still 1.30 GB, 14 files).
- If CAM++ misses the targets, the alternatives (sherpa-onnx; pyannote, which needs a gated
  Hugging Face token and new packages) need a separate proposal.
