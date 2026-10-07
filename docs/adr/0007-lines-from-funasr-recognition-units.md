# ADR 0007 — Lines from FunASR recognition units

**Status:** Accepted (2026-10-06). Amends ADR 0006's "`sentence_info` is the only source of
segment boundaries".

## Context

A private listening check of a real-ASR episode found lines whose text ran ahead of the audio
by up to ~7 s, growing within each chunk and snapping back at each chunk cut, plus a few
seconds of speech shown only as punctuation at a chunk's end. A rerun of the same chunk
reproduced the stored output exactly. The cause is in FunASR 1.4.16's VAD path, reproduced
with invented input and no models (`tests/test_funasr_upstream.py`):

- Each VAD segment's text has one whitespace-separated unit per `timestamp` pair (a Chinese
  character, or a whole Latin word). `result["text"]` (and `raw_text`) joins segments with a
  space, so units and pairs still correspond one to one.
- The text it punctuates and splits into sentences is built by `_join_vad_texts`, which joins
  two segments **without** a space when both sides are Chinese. Each join fuses two characters
  into one unit.
- The CT-Transformer splits every character, so its punctuation ids stay one per pair, but
  `timestamp_sentence` pairs ids, pairs and the fused units by position (`zip_longest`). After
  each join, sentence text runs one character further ahead of its timing; at the chunk's end
  the leftover pairs become timed sentences holding only punctuation. Its warning compares only
  ids with pairs, so nothing is logged.

Pebble's per-sentence alignment flag saw part of this (lines whose own counts differed) but
not lines whose counts matched yet were shifted, and the whole-text consistency diagnostic
cannot see it (every character survives, attached to the wrong timing).

## Decision

- **Lines come from recognition units.** The provider calls `generate()` with
  `sentence_timestamp=True` and `return_raw_text=True`, and matches `raw_text`'s units, in
  order and exactly, against the punctuated `text`. Only whitespace and punctuation may come between
  units. Each unit keeps its own pair: nothing is split, interpolated, duplicated or
  redistributed, and Latin words are never split into guessed character timings.
- **Explicit boundary policy.** A line ends after `，` `。` `？` `、` (the marks FunASR itself
  ends sentences at) or `！` `!` `?` placed between units, with any closing quote or bracket
  right after it. Other punctuation never ends a line, and punctuation inside a unit never
  does, so a boundary can't fall inside a unit. For output without a VAD join, lines equal
  FunASR's own sentences exactly (pinned by test).
- **Fail closed.** Missing `raw_text`, a unit/pair count difference, a unit that doesn't
  appear next in the text, or text content beyond the units fails the chunk with
  `INTERNAL_ERROR` (generic copy, counts-only log). Pebble never falls back to
  the known-drifting `sentence_info`. Invalid times and the existing line checks keep
  `PROVIDER_ERROR`.
- **`raw_text` stays in memory.** It is never logged, stored, served or shown.
- **The alignment flag stays a diagnostic.** It now compares each line's tokens with its unit
  pairs. A flag alone doesn't prove misalignment, but discrepancies can accompany it.

## Consequences

- A verified mapping says the text and FunASR's unit timestamps correspond; it says nothing
  about how accurately those timestamps match the audio.
- Transcripts made before this change keep their drifted lines until reprocessed.
- A FunASR upgrade must re-check this: the version-pinned tests skip on other versions and say
  what to re-verify.
- If FunASR's punctuated text ever changes a unit's characters (case, width, digits), chunks
  fail instead of being guessed; that would need its own decision.
