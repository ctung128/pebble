# Demo fixture provenance

## demo-001 — "Why I built Pebble" (我为什么做 Pebble)

| Item         | Source                                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Script       | Original text written for Pebble (`demo-001/script.zh.txt`). Not derived from any podcast.                                                                            |
| Audio        | **AI-generated speech** (LuvVoice neural TTS), split into per-line files in `lines/` and joined by `scripts/build-demo-fixture.mjs <id> --lines`.                     |
| Transcript   | The script text, with timings measured from the per-line audio. **Not ASR output.**                                                                                   |
| Confidence   | `null` for every segment — no recognizer was involved.                                                                                                                |
| Translations | `demo-001/translations.en.json`: English written for the demo (`kind: "prepared-sample"`). Not machine translation.                                                   |
| Review marks | `demo-001/illustrative-uncertainty.json`: **simulated** "May need review" flags on two lines, chosen arbitrarily to exercise the UI. Not derived from any recognizer. |

## demo-002 — "Notes on my Substack blog" (我的 Substack 博客随笔)

| Item         | Source                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Script       | Original text written for Pebble (`demo-002/script.zh.txt`). Not derived from any podcast.                                                        |
| Audio        | **AI-generated speech** (LuvVoice neural TTS), split into per-line files in `lines/` and joined by `scripts/build-demo-fixture.mjs <id> --lines`. |
| Transcript   | The script text, with timings measured from the per-line audio. **Not ASR output.**                                                               |
| Confidence   | `null` for every segment — no recognizer was involved.                                                                                            |
| Translations | `demo-002/translations.en.json`: English written for the demo (`kind: "prepared-sample"`). Not machine translation.                               |
| Review marks | None.                                                                                                                                             |

## demo-003 — "Learning Pottery in Jingdezhen" (去景德镇学陶艺)

| Item         | Source                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Script       | Original text written for Pebble (`demo-003/script.zh.txt`). Not derived from any podcast.                                                        |
| Audio        | **AI-generated speech** (LuvVoice neural TTS), split into per-line files in `lines/` and joined by `scripts/build-demo-fixture.mjs <id> --lines`. |
| Transcript   | The script text, with timings measured from the per-line audio. **Not ASR output.**                                                               |
| Confidence   | `null` for every segment — no recognizer was involved.                                                                                            |
| Translations | `demo-003/translations.en.json`: English written for the demo (`kind: "prepared-sample"`). Not machine translation.                               |
| Review marks | None.                                                                                                                                             |

### Audio rights

All three episodes use audio generated with [LuvVoice](https://luvvoice.com) (free plan). LuvVoice
voices are provided through Microsoft Azure AI Speech and Google Cloud Text-to-Speech. Its Terms of
Service (last updated 2026-08-02, checked 2026-10-06) say the user owns the audio they generate and
may make it available to others, provided synthetic audio is disclosed where expected. The demo is
not monetized. Each episode is marked `"kind": "licensed"`, `"publishable": true` in
`manifest.json`, and the audio is disclosed as AI-generated there, in the audio file metadata and on
the portfolio page.

Each `lines/full-take.mp3` is the original single LuvVoice render of the script; the numbered
`lines/NN.wav` files are that take split at the pauses between lines. `lines/` is not deployed.

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

`npm run fixtures:build -- <episode-id> --lines` rebuilds an episode from its per-line files in `lines/` (`01.mp3`, `02.wav`, …, one per script line). Without `--lines` it renders a macOS TTS development placeholder instead (not publishable).
