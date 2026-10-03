# Pebble

Pebble is a local-first Mandarin podcast listening companion. You bring audio you own or are
authorized to use; Pebble turns it into a timestamped transcript you can read, replay line by
line, and learn from — all on your own machine.

> **Status: M0A.** This build is a static demo: a library, an audio player and a synced
> transcript reader running on bundled fixtures. Local transcription, learning items and export
> are not built yet — see [the roadmap](docs/ARCHITECTURE.md#roadmap).

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
