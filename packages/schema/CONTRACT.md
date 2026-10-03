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

## Manifest

`manifest.json` lists episodes. Paths are relative to the manifest; absolute paths, URL
schemes and `..` are rejected.

| Field                         | Type                                                                       |
| ----------------------------- | -------------------------------------------------------------------------- |
| `schemaVersion`               | `"1.x"`                                                                    |
| `episodes[]`                  | Episode, unique `id`                                                       |
| `episode.id`                  | lowercase slug                                                             |
| `episode.title`               | non-empty string                                                           |
| `episode.titleZh`             | string, optional                                                           |
| `episode.description`         | string                                                                     |
| `episode.language`            | BCP 47 tag, e.g. `zh-CN`                                                   |
| `episode.durationMs`          | positive integer                                                           |
| `episode.audio`               | `{ src: relative path, mimeType: "audio/*" }`                              |
| `episode.transcript`          | `{ src: relative path }`                                                   |
| `episode.audioProvenance`     | `{ kind, publishable, notes }`                                             |
| `audioProvenance.kind`        | `tts-placeholder` \| `self-recorded` \| `licensed` \| `permission-granted` |
| `audioProvenance.publishable` | `false` until rights to distribute publicly are documented                 |

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
