# ADR 0003 — Public demo uses authorized fixtures only

**Status:** Accepted (2026-10-03)

## Context

The portfolio demo must be publicly viewable without exposing a processing endpoint or
redistributing audio Pebble has no rights to.

## Decision

- The public demo is a static build using `DemoFixtureSource` only: no worker URL, no upload
  or transcription path, no API keys.
- Demo content is limited to original or explicitly authorized audio and transcripts, with
  provenance recorded in `fixtures/demo/PROVENANCE.md` and in each episode's
  `audioProvenance` (`kind`, `publishable`).
- The M0A fixture uses synthetic TTS audio marked `tts-placeholder` / `publishable: false`.
  It is for local development only. The UI labels it, and labels authored transcripts as not
  being ASR output.

## Consequences

- Before any public deployment the placeholder must be replaced with self-recorded, licensed
  or permission-granted audio. M3 adds a build guard that fails when any episode is
  `publishable: false`.
- The demo shows reading and playback, not transcription quality; it must never imply
  otherwise.
