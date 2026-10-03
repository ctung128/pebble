# Demo fixture provenance

## demo-001 — "A Pebble on the Way Home" (回家路上的一颗石子)

| Item         | Source                                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Script       | Original text written for Pebble (`demo-001/script.zh.txt`). Not derived from any podcast.                                                                            |
| Audio        | **Synthetic macOS text-to-speech** (voices: Tingting, Eddy zh_CN), rendered by `scripts/build-demo-fixture.mjs`.                                                      |
| Transcript   | The script text, with timings measured from the per-line renders. **Not ASR output.**                                                                                 |
| Confidence   | `null` for every segment — no recognizer was involved.                                                                                                                |
| Translations | `demo-001/translations.en.json`: English written for the demo (`kind: "prepared-sample"`). Not machine translation.                                                   |
| Review marks | `demo-001/illustrative-uncertainty.json`: **simulated** "May need review" flags on two lines, chosen arbitrarily to exercise the UI. Not derived from any recognizer. |

### ⚠️ Development placeholder — not for public deployment

The audio is generated with operating-system voices whose terms for public redistribution
have not been reviewed. It is marked `"kind": "tts-placeholder"`, `"publishable": false` in
`manifest.json`, and the app labels it as a placeholder.

**Before any public deployment, replace it** with audio that is self-recorded, licensed, or
used with documented permission, and update this file.

## Replacing a fixture

1. Put the authorized audio at `fixtures/demo/<episode-id>/audio.m4a` (or another
   browser-playable format; update `audio.src` and `audio.mimeType`).
2. Write `transcript.json` following `packages/schema/CONTRACT.md` (from M0C the local
   worker can produce it). Use `provenance.kind: "asr"` for recognizer output and record the
   provider/model; use `"fixture"` for hand-authored timings.
3. Update the episode in `manifest.json`: `durationMs`, and `audioProvenance` with the
   correct `kind`, `publishable: true` only once rights are documented, and notes.
4. Record the source and permission here.
5. Run `npm test` — `packages/schema/test/fixtures.test.ts` validates every fixture.

`npm run fixtures:build` only regenerates the TTS placeholder; it is not needed for real audio.
