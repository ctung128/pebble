# Pebble — notes for Claude Code

Pebble is a local-first Mandarin podcast listening companion (portfolio project). Product
name is **Pebble** everywhere user-facing. Package namespace is `@pebble/*`.

## Current milestone

M0A (static demo reader) and M0B (pinyin, on-demand translation, simulated review marks,
corrections, learning items, Anki CSV export, browser-side LearningStore) are done. **Do not start a milestone without the
user's explicit go-ahead.** Roadmap and scope: `docs/ARCHITECTURE.md`.

M0C-1 (local worker, `services/worker`) and M0C-2 (web local mode, `apps/web/src/local`,
`npm run dev:local` on 5175) are committed. Worker: `npm run worker`, `npm run worker:doctor`,
`npm run test:worker`, `npm run worker:models -- list|verify|pull`. Default port 8790 (8765 is
AnkiConnect's). Read `docs/LOCAL_MODE.md` and `docs/MODELS.md` before changing the worker.

**M1-A (FunASR setup, smoke test, provider integration) is committed (5b4538f); M1-C0
(provider-aware local health and flow copy, health contract 1.5) is the current narrow fix.**
Dependency setup is approved: the worker's optional `funasr` extra (`funasr==1.4.16`, `modelscope==1.40.1`,
`torch==2.11.0` + `torchaudio==2.11.0` as a matched pair) plus the resolver constraint
`transformers>=4.32.0,<5` (never a direct dependency; don't block or patch it — FunASR imports
it during package initialization). Use `UV_CACHE_DIR=~/.pebble/uv-cache`. M1-B: B1 tooling is committed and the
B2 starter runs on the user's two private clips are done (results only under `~/.pebble`). The
`timestamp_alignment_anomaly` flag is a private developer/benchmark diagnostic, not a learner
signal: it earns no review slot and gets no UI. M1-B2 adds a **benchmark-only** chunk-overlap
experiment (`bench run --overlap-ms`, `compare`, `pair`, `tally`); the worker's jobs never
overlap. ASR research is paused; the current work is private-pilot readiness. Slice 1 (tester
commands `npm run pebble:doctor|setup|start|stop`, safe port/lifecycle, health `instanceId` in
contract 1.6) is the approved scope; Slice 2 (library, delete, reader QA, guides) needs its own
approval. Don't start new benchmark runs, change the
150 s chunk default or other defaults, or build a corpus from the user's files without approval.
Broader M1-C (web/UI) needs a separately approved plan. Commits need the user's explicit
"commit" after a shown status/diff/privacy scan. Never put recognized transcript
text, private audio or private clip paths in the repository, tests, docs or commits.

Approved models — exactly these, pinned in `services/worker/src/pebble_worker/models/manifest.py`
(the source of truth; never a floating "latest"):

- `iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch` @ `v2.0.9`
- `iic/speech_fsmn_vad_zh-cn-16k-common-pytorch` @ `v2.0.4`
- `iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch` @ `v2.0.4`

Optional, evaluation only (ADR 0009): `iic/speech_campplus_sv_zh-cn_16k-common` @ `v2.0.2` in
`SPEAKER_MODELS` (never in `MANIFEST`; `npm run worker:models -- pull|verify --speaker`).
Health, doctor, setup, startup, transcription and translation must never require it.

Speaker diarization (ADR 0009): CAM++ is approved for an experimental first version. The
evaluation is done; don't run more benchmarks without approval. The synthetic-tested core, the
child-process runner, the store and migration 3 live in `pebble_worker/speakers` and `db.py`
(uncommitted, under review), with routes, runner scheduling, health, contract 1.9 and the
local speaker UI (`apps/web/src/local/speakers`, tested with fake worker responses only). No
automatic runs; a real CAM++ smoke run and activation each need approval. Migration 3 applies automatically on worker
start, so don't restart Pebble on this tree until it is approved. Socket-opening tests (the five
worker port tests and `npm run test:scripts`) need explicit approval before any run. The speaker child runs only inside the macOS
Seatbelt network sandbox (`speakers/isolation.py`); never add an unsandboxed fallback. Migration 3, contract 1.9, production routes, queue integration,
UI and automatic runs each need review first. No automatic small-cluster merges, music
classification, mixed-line warnings or line splitting. Speaker labels never enter DeepL source
text. Keep transcript text, segment IDs and translation
cache identity unchanged; generic episode-local IDs only; no cross-episode recognition or stored
voiceprints; embeddings stay in memory.

Not approved: the larger Chinese-English punctuation model, any other FunASR model, speaker
diarization beyond the ADR 0009 evaluation, MPS support/configuration, cloud or API
transcription, any translation provider other than DeepL as specified in ADR 0008, and model
weights in Git, the public demo, or any deployment artifact.

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
- Worker binds 127.0.0.1 only; keep the Host/Origin checks and the explicit origin allowlist;
  never serve paths outside the data directory. Mock output is `mock`, never `asr`.
- FunASR provider: `PEBBLE_PROVIDER=funasr` explicit, no fallback to mock, CPU only, lazy
  loading, verified local model paths with update checks off, `confidence` always `null`.
  Segments come only from `sentence_info` or from a validated reconstruction from FunASR's
  raw units, their timestamp pairs and its punctuated output (ADR 0007); fail rather than
  guess. Review flags are not
  confidence and never rewrite text.
- DeepL English line translation (ADR 0008, `docs/TRANSLATION.md`, contract 1.8) is
  implemented in the worker and local app and is in use. Keep it working. Off by default, worker
  only. The worker reads `DEEPL_AUTH_KEY` from its environment only to authenticate requests;
  it never returns, prints, logs, or persists the key. One displayed line per explicit tap,
  never batch, background or on export; worker-enforced consent and limits. Tests,
  benchmarks and development work never call DeepL.
- Model weights live only in `~/.pebble/models` (downloaded by `models pull`); never commit,
  bundle or serve them. Smoke-test audio and outputs stay out of the repository.
- Mock transcripts (`provenance.kind === "mock"`) are learning-locked: no pinyin, translation,
  saving, export or corrections. Keep the preview banner. Never call it "transcription".
- Local-mode code must stay out of the demo build (`__PEBBLE_LOCAL__`, check-demo-bundle).

## Conventions

- npm workspaces; exact dependency versions (`--save-exact`); commit `package-lock.json`.
- TypeScript strict + `noUncheckedIndexedAccess`; imports use explicit `.ts`/`.tsx` extensions.
- Data crosses boundaries only through `@pebble/schema` parsers (`parseManifest`,
  `parseTranscript`). Contract changes: update `packages/schema/CONTRACT.md` and examples.
- UI reads data only via the `EpisodeSource` interface (`apps/web/src/data`).
- Components are controlled where practical (`TranscriptReader` never touches audio).
- Learner data goes through `LearningProvider`/`LearningStore` (IndexedDB; memory in tests).
  Worker-owned persistence is planned for M0C+ (ADR 0004) — don't build sync early.
- Learner-facing copy never says "illustrative"; data and docs must.
- Pinyin is never generated by an LLM. Translations are only fetched on explicit request.
- CSS Modules + tokens in `apps/web/src/styles/tokens.css`; support dark mode and
  `prefers-reduced-motion`.

## Verify before reporting

`npm run typecheck && npm run lint && npm test && npm run build && npm run test:worker && npm run test:scripts`

Before any commit, run the privacy check in `CONTRIBUTING.md` and stage files explicitly.
