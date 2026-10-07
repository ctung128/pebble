# ADR 0006 — FunASR provider and sentence-level normalization

**Status:** Accepted (2026-10-03); boundaries amended by [ADR 0007](0007-lines-from-funasr-recognition-units.md)

## Context

M1 replaces the mock with real Mandarin speech recognition on the user's own computer. The
provider must be explicit, private and offline after setup, and honest about what it knows.
A smoke test of the pinned FunASR models (SeACo-Paraformer, FSMN-VAD, CT-Transformer
punctuation; [MODELS.md](../MODELS.md)) on one authorized 55-second clip showed usable
sentence-level timing in `sentence_info`, no confidence values, and per-character timestamps
whose split between sentences can be off by one character at a punctuation boundary.

## Decision

- **Explicit selection.** `PEBBLE_PROVIDER=funasr` selects FunASR; `mock` stays the default.
  Unknown values stop the worker. There is no automatic fallback between providers: a missing
  environment or model is reported in health and fails jobs with `PROVIDER_UNAVAILABLE`.
- **Local, verified, offline.** Models load lazily on the first transcription, only from the
  pinned manifest folders under `<data>/models`, only after every file's size and SHA-256
  verify, with FunASR's update check off. CPU only.
- **`sentence_info` is the only source of segment boundaries.** One sentence becomes one
  segment: `start`/`end` offset by the chunk start, text as recognized, `confidence`,
  `speaker` and `tokens` null. Character timestamps are used only to detect a mismatch.
- **Fail rather than guess.** Missing or invalid times, empty text, reversed or out-of-order
  sentences, sentences outside the chunk, overlaps beyond 100 ms, or text without sentence
  timing fail the job with a clear, non-retryable `PROVIDER_ERROR`. Pebble never rebuilds
  timing from characters, merges or splits sentences, or edits text.
- **No speech is an outcome, not an empty success.** A job whose audio yields no segments
  fails with `NO_SPEECH_DETECTED` (not retryable).
- **Structural review flags, not confidence.** Segments carry deterministic flags
  (`long_segment`, `short_fragment`, `speech_gap`, `timestamp_alignment_anomaly`) with the
  thresholds recorded in provenance. They are evidence for review and M1-B benchmarking, not
  shown to learners in M1-A, and never used to change text.
- **Provenance names everything.** Every ASR transcript records each model's ID and
  revision, the runtime package versions and device, and each segment's chunk index (schema
  1.4, all optional fields).
- **Privacy.** Logs record the output's structure and counts only, never recognized text.

## Consequences

- A sentence boundary placed one character off by the punctuation model stays as recognized;
  learners fix it by editing the line, and the anomaly flag makes such lines findable.
- Long sentences (up to ~8 s observed) are replayed as single lines.
- The first job after starting the worker pays for verification and loading (~18 s observed),
  and the loaded models keep about 2 GB of memory until the worker stops.
- The local web app still unlocks learning tools for any non-mock transcript; gating them for
  ASR output (and hiding English until a translation provider exists) is M1-C.
