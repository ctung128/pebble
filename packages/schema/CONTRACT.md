# Pebble data contract — v1

The JSON shapes exchanged between Pebble content sources (demo fixtures now, the local
worker from M0C) and the app. Validated by Zod in `src/` and, from M0C, by Pydantic in the
worker. Both are tested against `examples/`.

## Versioning

- Every top-level payload has `schemaVersion: "MAJOR.MINOR"`. The current version is `1.0`.
- Readers accept any `1.x` and **ignore unknown fields**, so minor versions may add optional
  fields.
- A different major is rejected with `UNSUPPORTED_VERSION`. Any other violation is
  `INVALID_PAYLOAD` with a list of `{ path, message }` issues.
- Breaking changes (removing/renaming fields, changing meaning) require a new major.

## Changelog

- **1.3** — Worker health may include `dataDir: { path, writable, hint }` (optional) so the
  local app can explain data-folder problems. `path` is the only filesystem path in any
  payload, abbreviated with `~` under the home folder.
- **1.2** — Transcript provenance `kind` adds `"mock"` (placeholder output, never `"asr"`).
  Audio provenance `kind` adds `"user-provided"` (local-mode files). New payloads: job and
  worker health. Invalid-example expectations move to `examples/expectations.json`, shared
  by the Zod and Pydantic tests.
- **1.1** — Manifest episodes may carry an optional `demo` object (prepared translations and
  illustrative review flags). New payload types: demo translations, illustrative uncertainty,
  correction, learning item (each at `1.0`).
- **1.0** — Manifest and transcript.

## Manifest

`manifest.json` lists episodes. Paths are relative to the manifest; absolute paths, URL
schemes and `..` are rejected.

| Field                         | Type                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `schemaVersion`               | `"1.x"`                                                                      |
| `episodes[]`                  | Episode, unique `id`                                                         |
| `episode.id`                  | lowercase slug                                                               |
| `episode.title`               | non-empty string                                                             |
| `episode.titleZh`             | string, optional                                                             |
| `episode.description`         | string                                                                       |
| `episode.language`            | BCP 47 tag, e.g. `zh-CN`                                                     |
| `episode.durationMs`          | positive integer                                                             |
| `episode.audio`               | `{ src: relative path, mimeType: "audio/*" }`                                |
| `episode.transcript`          | `{ src: relative path }`                                                     |
| `episode.audioProvenance`     | `{ kind, publishable, notes }`                                               |
| `audioProvenance.kind`        | `tts-placeholder` \| `self-recorded` \| `licensed` \| `permission-granted`   |
| `audioProvenance.publishable` | `false` until rights to distribute publicly are documented                   |
| `episode.demo`                | optional (1.1): `{ translations?, illustrativeUncertainty? }` relative paths |

## Transcript

| Field                  | Type                                                                   |
| ---------------------- | ---------------------------------------------------------------------- |
| `schemaVersion`        | `"1.x"`                                                                |
| `episodeId`            | must match the episode it is loaded for                                |
| `language`             | BCP 47 tag                                                             |
| `script`               | `simplified` \| `traditional` \| `unknown`                             |
| `durationMs`           | positive integer                                                       |
| `segments[]`           | Segment                                                                |
| `provenance`           | `{ kind, provider, model, createdAt, notes? }`                         |
| `provenance.kind`      | `fixture` (authored text, measured timings) \| `asr` (provider output) |
| `provenance.model`     | string or `null`                                                       |
| `provenance.createdAt` | ISO 8601                                                               |

### Segment

| Field        | Type                                   | Notes                                               |
| ------------ | -------------------------------------- | --------------------------------------------------- |
| `id`         | string, unique within the transcript   | stable reference for future learning items          |
| `index`      | integer, equals position (0-based)     |                                                     |
| `startMs`    | integer ≥ 0                            | non-decreasing across segments                      |
| `endMs`      | integer > `startMs`                    | ≤ `durationMs` + 500 ms tolerance                   |
| `text`       | non-empty string                       |                                                     |
| `speaker`    | string or `null`                       | opaque label; `null` without diarization            |
| `confidence` | number in [0, 1] or `null`             | **only** provider-reported values; `null` = unknown |
| `tokens`     | `{ text, startMs, endMs }[]` or `null` | sub-segment timings when the provider has them      |

Segments may overlap slightly (merged ASR chunks); they must be ordered by `startMs`.

### Honesty rules

- `confidence` is never synthesized. Fixture transcripts use `null`.
- Any future illustrative uncertainty data (M0B demo) must be distinguishable from provider
  output in the data itself, not only in the UI.

## Demo translations (`translations.en.json`)

`{ schemaVersion, episodeId, kind: "prepared-sample", language, translations: { [segmentId]: text } }`

Written by a person for the demo; `kind` cannot claim model output. Translations apply to the
segment's **original** text only.

## Illustrative uncertainty (`illustrative-uncertainty.json`)

`{ schemaVersion, episodeId, kind: "illustrative", purpose, segments: [{ segmentId }] }`

A **simulated** review state used to build and test the "May need review" UI before a real ASR
provider supplies meaningful signals. It carries no numeric confidence by design and does not
change transcript `confidence` (which stays `null`). Apps keep its origin as
`source: "illustrative"`; provider confidence below the review threshold is `source: "provider"`.

## Correction

| Field           | Type                                      |
| --------------- | ----------------------------------------- |
| `episodeId`     | episode id                                |
| `segmentId`     | segment id; one correction per segment    |
| `originalText`  | transcript text at the time of correction |
| `correctedText` | non-empty learner text                    |
| `updatedAt`     | ISO 8601                                  |

## Learning item

| Field                           | Type / rule                                                                |
| ------------------------------- | -------------------------------------------------------------------------- |
| `id`                            | unique string (UUID)                                                       |
| `kind`                          | `"segment"` (phrases may be added later as a new kind)                     |
| `episodeId`, `episodeTitle`     | source episode                                                             |
| `segmentId`, `startMs`, `endMs` | source segment and timing                                                  |
| `text`                          | Chinese as displayed when saved (corrected text if edited)                 |
| `originalText`                  | transcript text if the line was corrected, else `null`                     |
| `pinyin`                        | generated pinyin for `text` (when saving, or later on export), else `null` |
| `translation`                   | English if resolved (when saving, or later on export), else `null`         |
| `note`                          | learner note or `null`                                                     |
| `savedAt`, `updatedAt`          | ISO 8601                                                                   |
| `provenance`                    | `{ transcriptKind, transcriptProvider, corrected, audioKind }`             |

`originalText` must be set exactly when `provenance.corrected` is true.

## Job (1.2)

| Field                             | Type / rule                                                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `episodeId`, `episodeTitle` | job and episode identity                                                                                                                      |
| `status`                          | `queued` \| `running` \| `completed` \| `failed` \| `cancelled`                                                                               |
| `stage`                           | `probing` \| `normalizing` \| `chunking` \| `transcribing` \| `merging` \| `null` (current stage while running; last stage reached otherwise) |
| `attempt`                         | integer ≥ 1; increases on retry                                                                                                               |
| `progress`                        | `{ completedChunks, totalChunks }` once chunking has finished, else `null`; `completedChunks ≤ totalChunks`                                   |
| `failure`                         | `{ stage, code, message, retryable, hint }`; set exactly when `status` is `failed` or `cancelled`                                             |
| `provider`                        | `{ id, kind: "mock" \| "asr" }`                                                                                                               |
| `createdAt`, `updatedAt`          | ISO 8601                                                                                                                                      |

Failure codes: `FFMPEG_NOT_FOUND`, `UNSUPPORTED_MEDIA`, `NO_AUDIO_STREAM`, `AUDIO_TOO_LONG`,
`STORAGE_ERROR`, `PROVIDER_UNAVAILABLE`, `PROVIDER_ERROR`, `WORKER_RESTARTED`, `CANCELLED`,
`INTERNAL_ERROR`. See [docs/LOCAL_MODE.md](../../docs/LOCAL_MODE.md#failures).

## Worker health (1.2)

`{ schemaVersion, workerVersion, status: "ok" | "degraded", dataDirWritable, tools: { ffmpeg,
ffprobe: { available, version } }, providers: [{ id, kind, available, detail }] }`. Never
contains filesystem paths, except the optional `dataDir.path` (1.3).

## Validation in two languages

The worker validates with Pydantic (`services/worker/src/pebble_worker/contract.py`) for the
payloads it produces or reads: manifest/episode, transcript, job and worker health. Both
validators run against every file in `examples/`, and the expected code, path and message for
each invalid example live in `examples/expectations.json`. Browser-only payloads
(translations, illustrative uncertainty, corrections, learning items) are validated by Zod
only.
