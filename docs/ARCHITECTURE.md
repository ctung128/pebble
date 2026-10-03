# Pebble architecture

## Shape

```
┌──────────────────────────── your machine ─────────────────────────────┐
│ apps/web  (React + TS)                  services/worker  (M0C, Python)│
│  EpisodeSource ─┬─ DemoFixtureSource    FastAPI on 127.0.0.1 only     │
│                 └─ LocalWorkerSource ─► SQLite + files                │
│                    (M0C)                FFmpeg probe/normalize/chunk  │
│  Reader, player, learning UI            TranscriptionProvider         │
│                                          ├─ mock (M0C)                │
│                                          └─ funasr / Paraformer (M1)  │
└───────────────────────────────────────────────────────────────────────┘
┌──────────────────────── public demo (static) ─────────────────────────┐
│ apps/web built with DemoFixtureSource only — no worker URL, no upload │
└───────────────────────────────────────────────────────────────────────┘
```

- **Local-first** means a web app plus a worker bound to `127.0.0.1`. Audio never leaves
  the machine.
- **The contract** (`packages/schema`) is the only way data crosses a boundary: fixture →
  app now, worker → app from M0C. It is versioned JSON validated with Zod (TS) and, from
  M0C, Pydantic (Python), both tested against the same example payloads.
- **The UI depends on `EpisodeSource`**, not on where data comes from. Demo and local mode
  share every component.

## Web app (M0A–M0B)

| Module                                 | Responsibility                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `data/EpisodeSource.ts`                | Source interface + `SourceError` (`NOT_FOUND`, `NETWORK`, `INVALID_PAYLOAD`, `UNSUPPORTED_VERSION`) |
| `data/DemoFixtureSource.ts`            | Fetches `demo/manifest.json` and transcripts; validates; resolves audio URLs                        |
| `features/player/useAudioPlayer.ts`    | Wraps `<audio>`; rAF-polled time while playing; structured media errors                             |
| `features/reader/activeSegment.ts`     | Binary search: playhead → active line (gaps keep the previous line)                                 |
| `features/reader/TranscriptReader.tsx` | Controlled, memoized list of line buttons; `aria-current` on active                                 |
| `features/reader/useFollowActive.ts`   | Keeps the active line in view; manual scroll pauses following                                       |
| `features/episode/playerKeys.ts`       | Pure key → action mapping (Space, R, ←, →)                                                          |
| `features/episode/EpisodePage.tsx`     | Composes source, player, reader, keyboard, line state                                               |
| `features/pinyin/`                     | Lazy `pinyin-pro` loader + per-view visibility state                                                |
| `features/translation/`                | `TranslationProvider`, demo provider, session cache, per-line state                                 |
| `features/uncertainty/reviewHints.ts`  | Merges illustrative hints and (future) provider confidence                                          |
| `features/learning/`                   | `LearningStore` (IndexedDB / memory), context, items page, Anki CSV                                 |
| `features/corrections/`                | Whole-line correction editor                                                                        |

Routing is hash-based so the static build works on any host or subpath. Fixtures live in
`fixtures/demo/` and are copied into `apps/web/public/demo/` at dev/build time.

## Learner data (M0B)

`LearningProvider` keeps corrections and learning items in React state and writes them through
to a `LearningStore` (IndexedDB in the browser, in-memory in tests). If the store can't be
opened or a write fails, the app continues session-only and shows a notice. Corrections are
stored separately from transcripts, keyed by episode + segment; fixture files are never
modified. Translations are cached for the session only (`SessionCachedTranslationProvider`).

## Roadmap

| Milestone  | Scope                                                                                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0A** ✅ | Static demo shell, fixture contract, library/episode views, player, synced reader, keyboard                                                                          |
| **M0B** ✅ | Pinyin reveal, prepared demo translations, simulated review marks, corrections/revert, learning items, Anki CSV export                                               |
| M0C        | FastAPI worker, SQLite, FFmpeg probe/normalize/chunk, mock provider, polling, truthful progress, structured failures, local audio picker with ownership confirmation |
| M1         | FunASR/Paraformer provider: health checks, setup docs, model/version/license docs, benchmark command + report format, graceful fallback. No speed/accuracy promises. |
| M3         | Service worker/installable PWA, deploy config, publishable-audio guard                                                                                               |

Out of scope for V1: SRS/FSRS/flashcards, word segmentation, CC-CEDICT, accounts, cloud
processing, URL ingestion, platform integrations.

## Decisions

- [ADR 0001 — Web app plus a localhost worker](adr/0001-pwa-plus-local-worker.md)
- [ADR 0002 — Versioned JSON contract without code generation](adr/0002-versioned-json-contract-without-codegen.md)
- [ADR 0003 — Public demo uses authorized fixtures only](adr/0003-public-demo-uses-authorized-fixtures-only.md)
- [ADR 0004 — Learner data is browser-owned for now](adr/0004-browser-owned-learning-store.md)
