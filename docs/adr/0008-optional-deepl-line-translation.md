# ADR 0008 — Optional English line translation with DeepL

**Status:** Accepted (2026-10-06): the design is approved.

- **Worker implementation: complete** (contract 1.8): settings, storage, consent, the DeepL
  client with its time bound, `POST /translations`, cached retrieval and health.
- **Local web integration: in progress.** Per-line English, cached English, "Show saved
  English" and the consent dialog are built; fingerprint-safe saving, export safeguards,
  translation settings (including Withdraw), recovery after a monthly-limit reset and the
  demo-bundle guard are not (TRANSLATION.md, "Before real activation").
- **Real activation: not approved.** No live DeepL call has been made; a smoke test and real
  use each need separate approval.

Details: [TRANSLATION.md](../TRANSLATION.md).

## Context

Local real-ASR transcripts have pinyin, editing, saving and Anki export, but no English: no
translation provider was approved, and the worker made no outbound network calls. The learner
wants English for single lines, on request, for personal use, using their own DeepL account
(plan shown in the account: **DeepL API Developer**, a one-time credit of 1 million
characters).

Sending text to an external service changes Pebble's "nothing leaves this computer" promise,
so the exception has to be narrow, explicit, opt-in and enforced by the worker, not only by
the UI.

## Decision

- **Off by default; worker only.** The worker translates only when
  `PEBBLE_TRANSLATION_PROVIDER=deepl` and `DEEPL_AUTH_KEY` are both set in its environment.
  The browser never sees the key or talks to DeepL. The worker reads the key from its
  environment only to authenticate requests. It never returns, prints, logs, or persists the
  key.
- **One line per explicit tap.** A request carries one current displayed Chinese line (at most
  300 Unicode code points, NFC, containing Chinese) plus the language codes (`ZH` to `EN-US`)
  and the key. Never context lines, batches, whole transcripts, audio, titles, file names,
  paths, IDs, notes or correction history. Nothing is translated on upload, load, edit, cache
  retrieval, "Show saved English", saving or export.
- **Every eligible episode.** All existing and future completed real-ASR local episodes.
  Demo, mock and incomplete transcripts are excluded by the worker, not only the UI.
- **Worker-enforced, versioned consent**, shared by every browser using this worker, given
  once in a short dialog and withdrawable in translation settings. Withdrawal stops future
  submissions; it does not recall a request already started or change what DeepL received.
- **Worker SQLite is the authoritative cache**, owned by its episode (deleted with it), keyed
  by episode, segment, source fingerprint (SHA-256 of the exact submitted text), provider,
  target language and cache version. Older fingerprints are kept, so reverting an edit reuses
  its translation. No browser-persisted cache. Cached English stays readable whatever the
  provider, consent or limit state.
- **Pebble's own limits**, shared across all episodes: 300 reserved requests and 30,000
  submitted characters per UTC calendar month by default
  (`PEBBLE_TRANSLATION_MONTHLY_REQUEST_LIMIT`, `PEBBLE_TRANSLATION_MONTHLY_CHARACTER_LIMIT`).
  They are separate from, and don't track, the DeepL account's credit. Identical in-flight
  requests are deduplicated **before** usage is reserved; distinct requests reserve
  atomically.
- **Narrow transport.** Direct HTTPS to the fixed DeepL host only, verified TLS, no redirects,
  no proxies, bounded response, no automatic retries. Provider errors map to fixed safe codes;
  raw provider responses are never shown or logged.
- **Saved and exported English is a snapshot.** A learning item stores English only when its
  source fingerprint matches the current displayed (corrected) Chinese. Export uses saved
  snapshots and never calls DeepL for real-ASR items.
- **Attribution.** English shows "Translated by DeepL (deepl.com)" as a link.

## Consequences

- Pebble now has one opt-in path that sends learner-chosen text off the computer. Docs say so
  plainly; the dialog says only that line's Chinese text is sent and that DeepL's free-API
  terms allow indefinite storage.
- DeepL's current terms for the free API (as "DeepL API Developer") reserve the right to store
  submitted content perpetually and prohibit processing personal data with it. Whether API
  submissions are used for model training is **unresolved**: Pebble makes no claim either way.
- The browser supplies the displayed text; the worker validates its shape and fingerprint but
  cannot verify browser-owned corrections.
- Usage counters count **reserved** requests, an upper bound on outbound attempts: a request
  reserved just before a crash may never have been sent, and is not refunded.
- Behind a proxy-only network, translation is unavailable.
- No live DeepL test runs in CI; tests use invented text, fake providers and a fake HTTPS
  transport. A live smoke test is a separate, manual step.
