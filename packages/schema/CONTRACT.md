# Pebble data contract — v1

The JSON shapes exchanged between Pebble content sources (demo fixtures now, the local
worker from M0C) and the app. Validated by Zod in `src/` and, from M0C, by Pydantic in the
worker. Both are tested against `examples/`.

## Versioning

- Every top-level payload has `schemaVersion: "MAJOR.MINOR"`. The current version is `1.9`.
  The app gates translation on health's `translation` field, never on the minor version alone.
- Readers accept any `1.x` and **ignore unknown fields**, so minor versions may add optional
  fields.
- A different major is rejected with `UNSUPPORTED_VERSION`. Any other violation is
  `INVALID_PAYLOAD` with a list of `{ path, message }` issues.
- Breaking changes (removing/renaming fields, changing meaning) require a new major.

## Changelog

- **1.9** — Local speaker labels ([ADR 0009](../../docs/adr/0009-local-speaker-diarization-evaluation.md)).
  - **Health:** worker health may include `speakers: { state, hint }`, where `state` is `ready`,
    `model_missing`, `model_incomplete` or `isolation_unavailable`. It is absent from older
    workers, which means unavailable, and it never affects `status`.
  - **New payloads:** speaker run request, episode speakers and speaker corrections request (see
    [Speakers](#speakers-19)).
  - **Routes:**
    - `POST /episodes/{id}/speakers`
    - `GET /episodes/{id}/speakers`
    - `PUT /episodes/{id}/speakers/corrections`
    - `POST /episodes/{id}/speakers/runs/{runId}/cancel`
  - Transcript, translation and learning-item payloads are unchanged.
- **1.8** — Optional DeepL line translation
  ([docs/TRANSLATION.md](../../docs/TRANSLATION.md), ADR 0008). Worker health may include
  `translation` (see [Translation](#translation-18)); absent means translation is off. New
  payloads: translation request, translation result, episode translations (cached English),
  consent request and consent. None carries the API key or a provider's own error text. 1.8
  workers include `translation` in health whenever they can read their database (omitted
  otherwise, which means off) and add `POST /translations`, `GET /episodes/{id}/translations`
  and `PUT`/`DELETE /translation/consent`.
- **1.7** — Jobs may include `durationMs` (the audio's measured length, once known) and
  `lineCount` (transcript lines, completed jobs only). Both are omitted while unknown, never
  `0`. The local worker adds `PATCH /episodes/{id}` with `{ "title" }` to rename an episode's
  user-facing title (see [docs/LOCAL_MODE.md](../../docs/LOCAL_MODE.md)); it changes nothing
  else about the episode and returns the episode's job.
- **1.6** — Worker health may include `instanceId` (32 lowercase hex characters): a random
  nonce for one run of a worker started by `npm run pebble:start`. It exists so
  `npm run pebble:stop` only ever signals the worker that run started; it is not a secret or a
  credential, carries no user data, and appears only in the local `/health` response (the
  public demo never contacts a worker). Learning items may include `sourceDeletedAt`: the item's
  local episode (audio and transcript) was deleted; the item itself is kept.
- **1.5** — Worker health providers may include `state` (`ready`, `checking`,
  `environment_missing`, `models_missing`, `verification_failed`, `load_failed`) and `hint`
  (plain-language remediation safe to show in the app, at most one command). Readers fall back
  to `available` when `state` is absent; `detail` stays developer diagnostics.
- **1.4** — ASR transcripts from the local worker may carry, all optional: segment
  `chunkIndex` and `review: { flags }` (structural review flags, **not confidence**), and
  provenance `models` (`{ role, id, revision }` for every model), `runtime` (package versions
  and device) and `review.thresholds`. Job failures add `NO_SPEECH_DETECTED`.
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

| Field                  | Type                                                                              |
| ---------------------- | --------------------------------------------------------------------------------- |
| `schemaVersion`        | `"1.x"`                                                                           |
| `episodeId`            | must match the episode it is loaded for                                           |
| `language`             | BCP 47 tag                                                                        |
| `script`               | `simplified` \| `traditional` \| `unknown`                                        |
| `durationMs`           | positive integer                                                                  |
| `segments[]`           | Segment                                                                           |
| `provenance`           | `{ kind, provider, model, createdAt, notes? }`                                    |
| `provenance.kind`      | `fixture` (authored text, measured timings) \| `asr` (provider output)            |
| `provenance.model`     | string or `null`                                                                  |
| `provenance.createdAt` | ISO 8601                                                                          |
| `provenance.models`    | optional (1.4): `{ role: asr \| vad \| punctuation, id, revision }[]`             |
| `provenance.runtime`   | optional (1.4): string map, e.g. `{ funasr, torch, device }`                      |
| `provenance.review`    | optional (1.4): `{ thresholds: { longSegmentMs, shortFragmentMs, speechGapMs } }` |

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
| `chunkIndex` | optional integer ≥ 0 (1.4)             | worker processing chunk that produced the segment   |
| `review`     | optional `{ flags }` (1.4)             | structural review flags; see below                  |

Segments may overlap slightly (merged ASR chunks); they must be ordered by `startMs`.

### Honesty rules

- `confidence` is never synthesized. Fixture transcripts use `null`.
- `review.flags` (1.4) are deterministic notes about a segment's shape, never confidence:
  `long_segment`, `short_fragment`, `speech_gap` (computed from timing against
  `provenance.review.thresholds`) and `timestamp_alignment_anomaly` (the provider's
  sub-segment timings don't match the text). They must not be presented as confidence or used
  to rewrite text.
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
| `sourceDeletedAt`               | optional (1.6): ISO 8601, when the item's local episode was deleted        |
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
| `durationMs?`                     | 1.7: integer > 0, the audio's measured length; omitted until known                                                                            |
| `lineCount?`                      | 1.7: integer ≥ 0, transcript lines; only on `completed` jobs                                                                                  |

Failure codes: `FFMPEG_NOT_FOUND`, `UNSUPPORTED_MEDIA`, `NO_AUDIO_STREAM`, `AUDIO_TOO_LONG`,
`STORAGE_ERROR`, `PROVIDER_UNAVAILABLE`, `PROVIDER_ERROR`, `NO_SPEECH_DETECTED` (1.4),
`WORKER_RESTARTED`, `CANCELLED`,
`INTERNAL_ERROR`. See [docs/LOCAL_MODE.md](../../docs/LOCAL_MODE.md#failures).

## Worker health (1.2)

`{ schemaVersion, workerVersion, status: "ok" | "degraded", dataDirWritable, tools: { ffmpeg,
ffprobe: { available, version } }, providers: [{ id, kind, available, detail, state?, hint? }] }`.
The worker lists exactly the provider it is configured with. `state` and `hint` are 1.5;
`instanceId?` is 1.6 (present only when started by `pebble:start`). Never contains filesystem
paths, except the optional `dataDir.path` (1.3).

## Translation (1.8)

Shared rules for the local worker and app. Text is never trimmed or rewritten.

Requests carry `schemaVersion` like every other payload: any `1.x` is accepted, a missing or
malformed value is `INVALID_PAYLOAD`, another major is `UNSUPPORTED_VERSION`. The existing
rename body (`PATCH /episodes/{id}`) is unchanged and carries none.

**Chinese line** (`text` in a request): checked in this order, first failure reported —
no unpaired surrogates; no control characters (Unicode `Cc`); 1–300 Unicode **code points**;
already NFC-normalized; contains at least one Han ideograph (U+3400–4DBF, U+4E00–9FFF,
U+F900–FAFF, U+20000–2FA1F, U+30000–323AF). Shared cases: `examples/translation-text.json`.

**English** (`text` in a result or cache row): not empty after trimming, at most 2,000 code
points, no unpaired surrogates, no control characters except tab, line feed and carriage return.

**Fingerprint:** SHA-256 of the exact submitted text's UTF-8 bytes, 64 lowercase hex characters.

| Payload              | Fields                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Health `translation` | `provider: "deepl"`, `configured`, `consent`, `consentVersion`, `newRequests`, `limits`                                                                                              |
| `limits`             | `period` (`YYYY-MM`, UTC), `requestsUsed`, `requestLimit` (> 0), `charactersUsed`, `characterLimit` (> 0)                                                                            |
| Translation request  | `schemaVersion`, `episodeId`, `segmentId`, `text`                                                                                                                                    |
| Translation result   | `schemaVersion`, `episodeId`, `segmentId`, `fingerprint`, `provider`, `targetLanguage: "EN-US"`, `text`, `source: "cache" \| "provider"`, `createdAt`                                |
| Episode translations | `schemaVersion`, `episodeId`, `provider`, `targetLanguage`, `cacheVersion: 1`, `translations[]` of `{ segmentId, fingerprint, text, createdAt }`, unique per segment and fingerprint |
| Consent request      | `schemaVersion`, `provider`, `consentVersion`                                                                                                                                        |
| Consent              | `schemaVersion`, `provider`, `status: "current" \| "required"`, `consentVersion`, `grantedAt` (set exactly when current)                                                             |

**Health readiness** — separate facts, which must agree:

| `configured` | `consent`        | `newRequests`                                                            |
| ------------ | ---------------- | ------------------------------------------------------------------------ |
| `false`      | `not_configured` | `off`                                                                    |
| `true`       | `required`       | `consent_required`                                                       |
| `true`       | `current`        | `local_limit_reached` if either used count ≥ its limit, else `available` |

Reading cached English depends on none of them.

**Error codes** for translation routes: `TRANSLATION_OFF`, `TRANSLATION_CONSENT_REQUIRED`,
`TRANSLATION_LOCAL_LIMIT`, `TRANSLATION_RATE_LIMITED`, `TRANSLATION_PROVIDER_QUOTA`,
`TRANSLATION_KEY_REJECTED`, `TRANSLATION_REQUEST_REJECTED`, `TRANSLATION_UNAVAILABLE`,
`TRANSLATION_INVALID_TEXT`, `TRANSLATION_NOT_ALLOWED`, `EPISODE_NOT_FOUND`,
`SEGMENT_NOT_FOUND`, in the usual `{ "error": { "code", "message", "hint"? } }` shape with fixed
messages ([docs/TRANSLATION.md](../../docs/TRANSLATION.md#errors)).

## Validation in two languages

The worker validates with Pydantic (`services/worker/src/pebble_worker/contract.py`) for the
payloads it produces or reads: manifest/episode, transcript, job, worker health and the 1.8
translation payloads. Both
validators run against every file in `examples/`, and the expected code, path and message for
each invalid example live in `examples/expectations.json`. Browser-only payloads
(translations, illustrative uncertainty, corrections, learning items) are validated by Zod
only.

## Speakers (1.9)

Local speaker labels ([ADR 0009](../../docs/adr/0009-local-speaker-diarization-evaluation.md)).
Clients that don't know about speakers are unaffected: health's `speakers` field and the routes
are additive. Payloads carry ids, times, counts and names the learner typed: never transcript
text, audio or embeddings. Speaker names are display-only and never part of DeepL source text.

**Speaker run request** (`POST /episodes/{id}/speakers`). `{ schemaVersion, speakerCount? }`,
where `speakerCount` is an optional hint of 1–15 (null or absent: automatic). The JSON body is
at most 1 KiB and may not repeat keys.

- **202:** the episode speakers, with `latest.status: "queued"`. The handler only validates and
  claims the work; it never loads a model, reads audio or runs inference.
- **404 `NOT_FOUND`:** no such episode.
- **409:**
  - `EPISODE_NOT_READY`: transcription hasn't finished;
  - `SPEAKERS_NOT_ELIGIBLE`: the episode has no real (ASR) transcript;
  - `AUDIO_UNAVAILABLE`: the audio is gone;
  - `SPEAKER_RUN_ACTIVE`: a run is already queued or running. Claiming is atomic, so concurrent
    requests start at most one run.
- **503:** `SPEAKER_MODEL_UNAVAILABLE` or `SPEAKER_ISOLATION_UNAVAILABLE`, with a `hint`.

**Reading** (`GET /episodes/{id}/speakers`) is side-effect free and returns the episode speakers.

**Corrections** (`PUT /episodes/{id}/speakers/corrections`). The body is at most 1 MiB of
actual bytes, with no repeated keys. It must name the run and the `revision` the edit was based
on. Refusals use fixed copy and never echo names or validation details:

- `SPEAKER_CORRECTIONS_INVALID` (422);
- `SPEAKER_RUN_MISMATCH` (409): not the episode's current run;
- `SPEAKER_RUN_NOT_COMPLETED` (409);
- `SPEAKER_CORRECTIONS_STALE` (409): the revision changed. Nothing is overwritten.

**Cancel** (`POST /episodes/{id}/speakers/runs/{runId}/cancel`) cancels exactly that run if it is
queued or running. For a run that already ended it changes nothing (idempotent), and it never
affects any other run. It returns the episode speakers; 404 if the run isn't the episode's.

**Episode speakers.** `{ schemaVersion, episodeId, current, latest }`.

- `current` is the latest **completed** run for the current transcript, or `null`. It stays
  while a re-detection is queued, running, failed or cancelled. Fields:
  - `runId` (`spk-` + 12 hex) and `completedAt`;
  - `provenance`: `{ modelId, modelRevision, clustering, windows, noiseWindows,
unassignedLines }`;
  - `speakers`: `[{ id, lines, windows }]`, with ids exactly `S1…Sn` in order;
  - `assignments`: the original assignments, segment id → speaker id or `null` (unassigned);
  - `corrections`: `null`, or `{ names, merges, notSpeaker, lines, updatedAt }`;
  - `effective`: the assignments with the corrections applied, covering exactly the same lines.
- `current.provenance.speakerCountHint` is the run's hint or `null`; stored corrections carry a
  `revision` (1, 2, …).
- `latest` is the most recent run of any status, or `null`: `{ runId, status, failure,
createdAt, updatedAt }`.
  - `status` is `queued`, `running`, `completed`, `failed` or `cancelled`.
  - `failure` is `{ code, message, retryable }`, set exactly when the run failed or was
    cancelled. The message is fixed copy.

**Failure codes:** `SPEAKER_MODEL_UNAVAILABLE`, `AUDIO_UNAVAILABLE`, `INVALID_INPUT`,
`EMBEDDING_FAILED`, `CLUSTERING_FAILED`, `NETWORK_ISOLATION_FAILED`, `TIMED_OUT`, `CANCELLED`,
`WORKER_RESTARTED`, `CHILD_FAILED`, `RESULT_INVALID`, `TRANSCRIPT_CHANGED`.

Segment ids used as keys in speaker payloads are ASCII (`[A-Za-z0-9._:-]{1,64}`), so ordering is
the same in every language. With corrections present, `effective` may name only visible
speakers: never a merged-away or not-a-speaker cluster.

**Speaker corrections request.** `{ schemaVersion, episodeId, runId, revision, names, merges,
notSpeaker, lines }`. It replaces the run's corrections as a whole. `revision` is the stored
revision the edit was based on, `0` when none is saved yet.

- `names`: speaker id → name. A name is 1–60 code points, NFC, with no control characters, and
  not empty.
- `merges`: source → target. A speaker can't merge into itself, and a merge target can't itself
  be merged (no chains).
- `notSpeaker`: unique speaker ids whose lines show as unassigned, for example music. These
  clusters can't be merged.
- `lines`: segment id → speaker id, or `null` for not-a-speaker/unassigned. A line can only be
  reassigned to a speaker that is neither merged away nor marked not-a-speaker.
- A merged-away speaker can't be named.
- **Bounds:** at most 200 entries each in `names`, `merges` and `notSpeaker`, and 20,000 in
  `lines`.
- **Order:** issues are reported in a fixed order, whatever the key order:
  1. sizes;
  2. merges, by speaker number: self-merge, chain or cycle, not-a-speaker;
  3. duplicate not-a-speaker entries;
  4. names of merged speakers;
  5. line targets, by segment id.
- **Privacy:** messages never repeat a submitted name. Names are user-entered display text, not
  transcript text, and never part of DeepL source text.
- **Run checks:** the worker additionally checks every id against the run's own speakers and
  lines, and accepts corrections only for the episode's current run.
