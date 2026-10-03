# Pebble — notes for Claude Code

Pebble is a local-first Mandarin podcast listening companion (portfolio project). Product
name is **Pebble** everywhere user-facing. Package namespace is `@pebble/*`.

## Current milestone

M0A is done: static demo source, validated fixture contract, library + episode views, audio
player, synced transcript reader, keyboard controls. **Do not start a milestone without the
user's explicit go-ahead.** Roadmap and scope: `docs/ARCHITECTURE.md`.

## Hard boundaries

- No Xiaoyuzhou (or any platform) integration, scraping, URL ingestion, downloading, or
  bypassing content protections. The product starts at a user-selected local audio file.
- No accounts, billing, cloud jobs, public upload or public transcription endpoints.
- Public demo = static build + authorized fixtures; it must run with no keys, Python,
  FFmpeg, models or worker.
- No SRS/FSRS/flashcards/review scheduling, word segmentation or CC-CEDICT in V1.
  Saved content is called **learning items** (segment-level now; phrases later).
- No system-level installs (uv, brew, models) without showing exact commands and getting
  separate approval.
- Never fabricate ASR quality signals. `confidence: null` means unknown. Any illustrative
  values (M0B) must be labeled as such in data and UI.
- No git commits unless the user asks.

## Conventions

- npm workspaces; exact dependency versions (`--save-exact`); commit `package-lock.json`.
- TypeScript strict + `noUncheckedIndexedAccess`; imports use explicit `.ts`/`.tsx` extensions.
- Data crosses boundaries only through `@pebble/schema` parsers (`parseManifest`,
  `parseTranscript`). Contract changes: update `packages/schema/CONTRACT.md` and examples.
- UI reads data only via the `EpisodeSource` interface (`apps/web/src/data`).
- Components are controlled where practical (`TranscriptReader` never touches audio).
- CSS Modules + tokens in `apps/web/src/styles/tokens.css`; support dark mode and
  `prefers-reduced-motion`.

## Verify before reporting

`npm run typecheck && npm run lint && npm test && npm run build`
