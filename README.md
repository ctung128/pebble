# Pebble

Pebble is a local-first Mandarin podcast listening companion. You bring audio you own or are
authorized to use; Pebble turns it into a timestamped transcript you can read, replay line by
line, and learn from — all on your own machine.

> **Status: M0B.** A static demo with a synced transcript reader and line-level learning tools:
> pinyin, on-demand translation, review marks, corrections, learning items and Anki CSV export.
> Local transcription is not built yet — see [the roadmap](docs/ARCHITECTURE.md#roadmap).

> [!WARNING]
> **The bundled demo audio is a development placeholder.** It is synthetic macOS text-to-speech
> reading an original script. It must be replaced with self-recorded, licensed, or
> permission-granted audio before any public deployment. See
> [`fixtures/demo/PROVENANCE.md`](fixtures/demo/PROVENANCE.md).

## Run the demo locally

Requires Node 22+ and npm.

```bash
npm install
npm run dev            # http://localhost:5173
```

The demo needs no API keys, Python, FFmpeg, transcription models or worker.

| Key   | Action               |
| ----- | -------------------- |
| Space | Play / pause         |
| R     | Replay current line  |
| ← / → | Previous / next line |

Click or tap any line to play from it. Scrolling the transcript pauses auto-follow; use
**Back to current line** to resume.

### Line-level learning (M0B)

- **Pinyin** — per line or for all lines; hidden by default. Generated in the browser by
  [`pinyin-pro`](https://github.com/zh-lx/pinyin-pro) (rules + dictionary, no model), loaded only
  on first use. Readings can be wrong for some words, notably neutral tones.
- **English** — per line, only when asked. The demo serves **prepared sample translations**
  through a `TranslationProvider` interface; nothing is machine-translated.
- **May need review** — a learner-facing mark for lines worth re-listening to. In this demo the
  marks are a **simulated uncertainty state** from a separate fixture file
  (`illustrative-uncertainty.json`). The placeholder transcript has no ASR confidence data; real
  provider signals replace the simulation once a transcription provider exists.
- **Corrections** — edit a whole line; the original transcript text is kept, viewable and
  restorable with **Revert**.
- **Learning items** — save whole lines (pinyin and English are filled in on export, an optional note
  and provenance) and export them as [Anki-compatible CSV](docs/ANKI_EXPORT.md).

Learner data lives in this browser (IndexedDB). **Reset demo data** clears it; episode content is
never modified. If storage is unavailable, Pebble keeps working for the session and says so.

Development-only switches (ignored in production builds): `?storage=session` simulates
unavailable storage, `?translation=fail` makes translations fail. Put them before the `#`, e.g.
`http://localhost:5173/?storage=session#/episodes/demo-001`.

## Scripts

| Command                  | What it does                                                   |
| ------------------------ | -------------------------------------------------------------- |
| `npm run dev`            | Vite dev server (copies `fixtures/demo` into the app first)    |
| `npm run build`          | Typecheck + production build to `apps/web/dist`                |
| `npm run preview`        | Serve the production build                                     |
| `npm test`               | Contract, fixture and component tests (Vitest)                 |
| `npm run typecheck`      | TypeScript across workspaces                                   |
| `npm run lint`           | ESLint                                                         |
| `npm run format`         | Prettier                                                       |
| `npm run fixtures:build` | Regenerate the placeholder demo fixture (macOS `say` + FFmpeg) |

## Repository layout

```
apps/web/          React + TypeScript app (Vite, hash routing)
packages/schema/   Versioned JSON contract: Zod schemas, examples, CONTRACT.md
apps/web/src/assets/  Pebble logo (original + cropped mark and favicon)
fixtures/demo/     Demo manifest, transcript and audio + PROVENANCE.md
scripts/           Fixture generation
docs/              Architecture and decision records
```

## Product boundaries

Pebble starts at **a local audio file you choose**. It does not fetch, download, scrape or
ingest audio from URLs or third-party apps, and it does not work around any platform's content
protections. Acquiring audio — and having the right to process it — is the user's
responsibility. There are no accounts, cloud jobs or public upload endpoints; the public demo
uses bundled, authorized fixtures only.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/adr/](docs/adr/).
