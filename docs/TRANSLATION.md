# English line translation (DeepL)

> **Status: implemented and live.** ([ADR 0008](adr/0008-optional-deepl-line-translation.md).)
> Everything planned is built: the worker (contract 1.8), the local app's per-line English,
> cached English, **Show saved English**, the consent dialog, translation settings with
> **Withdraw** and an explicit re-check, fingerprint-safe saving, snapshot-only export and the
> demo-bundle guard. The automated suites use invented text and fake workers, providers or HTTPS
> transports only. The isolated provider smoke test against DeepL has passed, and English
> translation is in real use.

### Outstanding verification follow-ups

These are two separate things, and both remain open.

- **Live coverage is narrow.** The isolated provider smoke test passed. Beyond it, real TLS and
  DeepL's responses are exercised only by real use; no test suite makes a live call.
- **Complete verification has not happened.** There has been no uninterrupted full pass
  (`typecheck`, `lint`, `test`, `build`, `test:worker`, `test:scripts`) on one tree.
  - **Fixed:** `JobProgressPage` announcement synchronization, in `cd00303`. It was
    mutation-tested there: two mutations each failed 20 of 20 runs, and that file passed 30/30.
    On `cd00303`, the uninterrupted sandbox-compatible sequence passed; it included **one** full
    web run. Three clean full web runs (651/651 each) are **separate** evidence, not part of that
    sequence. Injected failures in the stop tests were also checked. The working-server
    assertion-failure path (which needs loopback) was not exercised.
  - **Unresolved:** the `AddAudioPage` and `EpisodeTitle` test failures (tracked separately).
  - **Partial evidence on 2026-10-07.** These results apply to a **mixed, uncommitted working
    tree** on top of `f0fd09c`: it held the diarization-evaluation changes (ADR 0009) and
    separate, external recognition-unit changes in `providers/funasr.py` and its tests. They are
    not evidence for any single change or commit.
    - The worker suite ran in full: 737 passed, 12 skipped (9 browser-only contract payloads; 3
      real-model tests gated by `PEBBLE_FUNASR_INTEGRATION`). The five port tests ran and
      passed; none were deselected.
    - **Process note: those port tests should not have run.** They were run without
      authorization, six times, with unrestricted network access, and one test briefly opened an
      all-interface (`0.0.0.0`) listener on an ephemeral port each time. One of the six runs went
      through `uv run`, which may sync the environment. Port tests need explicit approval, and
      checks use the environment's own executables (`.venv/bin/…`), not `uv run`.
    - `npm run test:scripts` ran all 5 files: 41 tests, 41 passed, 0 skipped. **These script
      tests also open listening sockets** (`ports.test.mjs`, `stop.test.mjs` and `testkit.mjs`
      bind 127.0.0.1, `0.0.0.0` and `::1` on ephemeral ports). They were run three times without
      authorization, like the worker port tests below, and must not be run again without
      approval.
    - Not run: `typecheck`, web `npm test` (including `demoBundleGuard.test.mjs`) and `build`.

**Demo bundle.** The demo build may contain no provider copy, attribution, translation routes,
consent or settings UI, or local translation code (`apps/web/scripts/demoBundleGuard.mjs`, which
checks every file in full). The single exception is the shared schema's provider identifier
(`TRANSLATION_PROVIDER = "deepl"`), which the demo bundles with the contract validators. It is
accepted only in its compiled context, followed directly by that module's next constants
(`EN-US`, `2e3`, the start of the Han-range table), and at most once. Any other occurrence fails
the build, including a lone literal elsewhere; if the build output changes shape, the guard fails
closed until its pattern is updated.

Optional, off by default, for the local app only. A learner taps **English** on one line;
the worker sends that line's Chinese to DeepL and keeps the result on this computer. The
public demo keeps its prepared sample translations and never contacts DeepL.

The worker reads the key from its environment only to authenticate requests. It never
returns, prints, logs, or persists the key.

## Setup

Set both in the worker's environment, then start Pebble:

| Variable                                     | Default | Notes                                             |
| -------------------------------------------- | ------- | ------------------------------------------------- |
| `PEBBLE_TRANSLATION_PROVIDER`                | unset   | `deepl` turns translation on; anything else stops |
| `DEEPL_AUTH_KEY`                             | unset   | Your DeepL API key; used only to authenticate     |
| `PEBBLE_TRANSLATION_MONTHLY_REQUEST_LIMIT`   | `300`   | Pebble's own limit, per UTC calendar month        |
| `PEBBLE_TRANSLATION_MONTHLY_CHARACTER_LIMIT` | `30000` | Pebble's own limit, per UTC calendar month        |

The worker refuses to start if `PEBBLE_TRANSLATION_PROVIDER` is anything but unset or
`deepl`, if a set key isn't one line without spaces (at most 512 characters), or if a limit
isn't a whole number from 1 to 1,000,000,000. Its messages never repeat these variables'
values. `deepl` with `DEEPL_AUTH_KEY` missing or empty doesn't block Pebble: transcription
works as usual, translation is off (as if not set up), and the worker says so once at
startup. `DEEPL_AUTH_KEY` without the provider setting is ignored. `pebble:start` passes the
key to the worker only, never to the web server.

**Two separate allowances.** The DeepL API Developer plan (as shown in the DeepL account) is a
one-time credit of 1 million characters. Pebble's monthly limits are separate: they cap what
this worker sends and don't track or show the DeepL credit. Pebble calls no DeepL usage
endpoint.

## What is sent, and when

- **Only on an explicit tap of English on one line.** Never after upload, on load, on edit,
  when reading cached English, from **Show saved English**, when saving a learning item, or on
  export. No batch or whole-episode translation.
- **Translation content:** that one line's Chinese, exactly as displayed (the learner's
  correction if there is one), in Unicode NFC, 1–300 code points, containing at least one
  Chinese character. Internal spaces and punctuation are kept.
- **The request also carries** the language codes (`ZH` to `EN-US`) and the API key in the
  `Authorization` header. Nothing else: no other lines, context, audio, titles, file names,
  paths, IDs, notes or correction history.
- **Eligible:** every completed real-ASR local episode, existing and future. Demo, mock and
  incomplete transcripts are refused by the worker.
- The browser supplies the displayed text; the worker checks its shape and computes its
  fingerprint but can't verify the browser's corrections.

## Consent

Asked once, enforced by the worker, shared by every browser that uses this worker. The first
English tap on a configured worker without current consent opens the dialog.

- Recording consent by itself never sends a line. Opening the dialog grants nothing.
- The dialog's **Translate** is one explicit action that authorizes both steps: record consent,
  then send the line that was tapped, once.
- After consent is recorded, the line is sent only if the same episode is still open, the line's
  text (and so its fingerprint) is unchanged, and the page is still there. Otherwise nothing is
  sent; the recorded consent stays, and a later tap is a new, explicit request.
- **Cancel** (or Escape) records nothing and sends nothing.
- If the worker refuses the consent version, the dialog says "That consent is out of date. Reload
  Pebble and review it again."; if recording fails otherwise, it says "Pebble couldn't record
  your choice. No translation request was sent." In both cases nothing is sent and nothing is
  retried by itself.

**Dialog** (exact copy; no expandable details):

> **Translate with DeepL?**
>
> Only this line's Chinese text is sent to DeepL. Your audio and the rest of the transcript
> stay on this computer. DeepL's free-API terms allow indefinite storage; don't send personal
> or confidential information.
>
> **Translate** · **Cancel**

**Translation settings** hold the fuller information and **Withdraw**:

- "English translation with DeepL: allowed for this computer" and **Withdraw**.
- The request also includes the language codes (Chinese to US English) and the DeepL key set
  up for Pebble on this computer. It doesn't include audio, other lines, titles, IDs, file
  names, folder paths, notes or edit history.
- Matching cached translations are reused without sending the line again.
- This choice applies to every browser that uses Pebble on this computer.
- Withdrawing stops future submissions; it doesn't stop a request that has already started or
  change what DeepL has already received.
- After withdrawal: "Saved English stays readable. New lines won't be sent to DeepL unless you
  allow it again."
- Links (new tab): [DeepL Terms](https://www.deepl.com/en/pro-license) ·
  [DeepL Privacy Policy](https://www.deepl.com/en/privacy).

Consent carries a version; changing the dialog's wording or what is sent asks again.

**Routes** (local only; no provider call):

- `PUT /translation/consent` with a consent request (`provider: "deepl"`, the current
  `consentVersion`) records consent and returns the consent status. Another version is refused
  with `TRANSLATION_CONSENT_REQUIRED` (409); a worker without translation set up refuses with
  `TRANSLATION_OFF` (409).
- `DELETE /translation/consent` withdraws consent and returns the status. It is idempotent and
  works whether or not translation is set up.
- Both keep the Host and Origin checks. `PUT` needs `application/json` (otherwise 415
  `UNSUPPORTED_CONTENT_TYPE`) and one plain `Content-Length` (none: 411 `LENGTH_REQUIRED`;
  repeated, malformed or with `Transfer-Encoding`: 400 `INVALID_LENGTH`) of at most 1 KiB. The
  worker counts the bytes it actually receives: more than 1 KiB is 413 `REQUEST_TOO_LARGE`,
  and a body that doesn't match the declared size is 400 `INVALID_LENGTH`. Malformed bodies
  are 422 `INVALID_REQUEST`.
- `POST /translations` with a translation request sends one line, following the order below,
  and returns a translation result (`source: "provider"` or `"cache"`). Same body rules as
  consent, with a 4 KiB cap. A string `text` that breaks the text rules is 422
  `TRANSLATION_INVALID_TEXT`; other malformed bodies are 422 `INVALID_REQUEST`.
- `GET /episodes/{id}/translations` returns the episode's cached English for the current cache
  version, oldest first. It is local and read-only and never contacts DeepL.

**Attribution** under every English line: "Translated by DeepL (deepl.com)", a link to
`https://www.deepl.com`.

### What DeepL's terms say (checked 2026-10-06)

- The terms call the free API "DeepL API Developer" and reserve the right to store submitted
  content and its translation perpetually (§3.3.2).
- They prohibit processing personal data with the free API (§8.3.11).
- They require displaying the DeepL brand (and domain, where applicable) with unedited
  translations shown to end users (§8.3.3).
- Whether API submissions are used to train DeepL's models is **unresolved**; Pebble makes no
  claim either way.

## Translation settings

Local mode only: the page "English translation" at `#/translation`. It isn't linked from the
sidebar, the episode menu or the usage meter; open it by its address. Status by readiness:

| Readiness              | Shown                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Not set up (`off`)     | English isn't set up for Pebble on this computer.                                                                        |
| Consent required       | English translation with DeepL isn't allowed on this computer yet. Pebble asks the first time you tap English on a line. |
| Allowed                | English translation with DeepL: allowed for this computer, and **Withdraw**                                              |
| Allowed, limit reached | The same, plus Pebble's monthly limit message and **Check again**                                                        |
| Just withdrawn         | Saved English stays readable. New lines won't be sent to DeepL unless you allow it again.                                |

- **Withdraw** needs a click, sends nothing to DeepL and deletes nothing (cached English and saved
  items stay readable). It shows "just withdrawn" only after the worker confirms. If the response
  fails or is lost, the page keeps the last confirmed status and says "Pebble couldn't confirm
  that your choice was withdrawn. Try again." — it doesn't claim consent is still current;
  **Withdraw** can be pressed again; nothing is retried or translated by itself. If the
  withdrawal did take effect, the next tap on a line gets `TRANSLATION_CONSENT_REQUIRED` from the
  worker, shows "Allow translation with DeepL first." and only opens the dialog on **Try again**.
  A request already reserved may still complete (see the order below).
- **Check again** (after Pebble's monthly limit was reached) re-reads the worker's health and
  nothing else: it never translates, never resets counts in the browser and never infers a new
  month from the browser's clock. If it fails: "Pebble couldn't check right now. The displayed
  status hasn't changed." Translating afterwards is still a separate tap.
- The details and links listed under Consent.

## Reading English

- **Cache.** Worker SQLite holds every translation, owned by its episode (deleted with it),
  keyed by episode, segment, source fingerprint (SHA-256 of the exact submitted text),
  provider, target language and cache version (1: DeepL, `EN-US`, no context, NFC rules v1).
  Nothing is cached in the browser beyond the open page.
- **Current or stale.** English whose fingerprint matches the line as displayed is current.
  If none matches, the newest row for that line (latest `created_at`, then highest row id) is
  shown as "English for an earlier version of this line" with **Translate again**, which is
  an explicit request. Reverting an edit makes its earlier translation current again.
- **Show saved English** (in the episode's ⋯ menu, after the pinyin toggle) reveals current cached English only; it
  never requests anything.
- Cached English stays readable when translation is off, consent is withdrawn or a limit is
  reached.
- **Saving** a learning item stores English only if its fingerprint matches the displayed text
  at that moment: never an earlier version, a pending or a failed request. Saving never asks for
  English, and a saved item is a snapshot that later edits or translations don't change.
- **Export** writes the saved snapshots only. For real-ASR items it never asks the worker for
  English or reads its cache; an item saved without English is exported without it.

## Limits and order of a request

Pebble's monthly limits are shared by all episodes and count **reserved** requests and
submitted characters (code points). A request:

1. Is validated: episode completed and real ASR, segment exists, text rules above.
2. Is fingerprinted, then looked up in the cache: a match returns immediately, with no
   consent or limit check.
3. Needs a configured provider and current consent.
4. Joins an identical request already in flight, if any; joined requests reserve nothing.
5. Otherwise becomes the owner, checks the cache again, then in one transaction rechecks
   consent and that the episode exists, and reserves one request and its characters unless a
   limit would be exceeded.
6. Makes one HTTPS call, without retries.
7. On success stores the result only if the episode and segment still exist; a translation
   for a deleted episode is discarded, never restored.

Each reservation is also recorded as an attempt (period, character count, consent version,
status, failure code, HTTP status, times): never the text, the translation, or episode or
segment ids, so attempts aren't tied to any episode and stay when one is deleted.

Identical requests that arrive while one is in flight wait for it (at most 20 s; then
`TRANSLATION_UNAVAILABLE`) and share its result or failure; a later tap is a new request. When
the worker starts, reservations left by a previous run are marked `unknown`; nothing is sent.
Withdrawing consent stops requests not yet reserved; one already reserved completes, and its
result is cached.

Reservations are never refunded. A reservation left behind by a crash may never have been
sent, so the counters are an upper bound on outbound attempts.

## Transport

Direct HTTPS to the fixed DeepL API host only (`api-free.deepl.com:443`), with certificate and
hostname verification. No redirects (any 3xx is a failure, so the key is never sent
elsewhere), no proxies (proxy settings are never read; the connection is never tunnelled), one
attempt, and a response of at most 64 KiB that must contain one non-empty translation of at
most 2,000 code points. Translation routes keep the worker's Host and Origin checks and accept
small JSON bodies only (4 KiB; 1 KiB for consent).

**Time bound.** The request that calls DeepL enforces a 15 s budget on a monotonic clock,
started before the host name is resolved. Noticing the timeout and cleaning up happen promptly
but are subject to thread-scheduling overhead, so the call can end slightly after 15 s:

- Every socket it opens is shut down by a watchdog when the budget runs out. That ends a
  blocked connect, TLS handshake, header read or body read.
- Each blocking socket operation also times out at the time left, and the body is read in
  chunks with the budget checked between them: a slow drip of small chunks can't extend it.
- Name resolution runs in a helper thread. Pebble stops waiting for it at the deadline, but the
  operating system's lookup can't be interrupted, so that thread may finish later on its own.
  It only resolves the fixed host: it can't start a request or store a result.
- Once the budget is spent, the request fails with `TRANSLATION_UNAVAILABLE` even if a
  response arrived at the last moment. Its attempt is recorded as failed, the reservation
  isn't refunded, nothing is cached, and nothing is retried. A later tap is a new request.

Requests that join an in-flight identical request wait at most 20 s for it. Deduplication is
per worker process: `pebble:start` runs one worker, and the database transaction enforces the
limits across processes either way.

**Health.** `/health` reports the `translation` block whenever the worker can read its
database. If it can't (for example, the data folder isn't writable), the block is left out,
which means translation is off, and the rest of health still reports the underlying problem
(`dataDirWritable`, `dataDir.hint`, `status: degraded`).

## Errors

Fixed messages; DeepL's own responses are never shown or logged (the log records the code,
HTTP status and character count only).

| Situation                                                     | Code                           | HTTP | Message                                                                                          |
| ------------------------------------------------------------- | ------------------------------ | ---- | ------------------------------------------------------------------------------------------------ |
| Translation not set up                                        | `TRANSLATION_OFF`              | 409  | English isn't set up for Pebble on this computer.                                                |
| No current consent (the app opens the dialog)                 | `TRANSLATION_CONSENT_REQUIRED` | 409  | Allow translation with DeepL first.                                                              |
| Pebble's monthly limit                                        | `TRANSLATION_LOCAL_LIMIT`      | 429  | Pebble's monthly translation limit on this computer has been reached. Saved English still shows. |
| DeepL 429                                                     | `TRANSLATION_RATE_LIMITED`     | 503  | DeepL is busy right now. Wait a moment, then tap English again.                                  |
| DeepL 456                                                     | `TRANSLATION_PROVIDER_QUOTA`   | 503  | Your DeepL account's character allowance has been reached. Check your DeepL account.             |
| DeepL 403                                                     | `TRANSLATION_KEY_REJECTED`     | 502  | DeepL didn't accept the key set up for Pebble.                                                   |
| DeepL 400 or 413                                              | `TRANSLATION_REQUEST_REJECTED` | 502  | DeepL couldn't translate this line.                                                              |
| Other DeepL status, 3xx, timeout, network, TLS, bad response  | `TRANSLATION_UNAVAILABLE`      | 503  | Translation is unavailable right now. Try again later.                                           |
| Text fails the rules                                          | `TRANSLATION_INVALID_TEXT`     | 422  | This line can't be translated.                                                                   |
| Demo, mock or incomplete transcript (the app shows no action) | `TRANSLATION_NOT_ALLOWED`      | 409  | Lines from this transcript can't be translated.                                                  |
| Unknown or deleted episode                                    | `EPISODE_NOT_FOUND`            | 404  | This episode or line no longer exists.                                                           |
| Unknown line                                                  | `SEGMENT_NOT_FOUND`            | 404  | This episode or line no longer exists.                                                           |

A joined request whose owner doesn't finish within 20 s also gets `TRANSLATION_UNAVAILABLE`.
The table above is checked against the worker's own copy by `test_translation_requests.py`.

## Testing

Invented text, fake providers and a fake HTTPS transport only; no live DeepL test runs in the
suite. The live smoke test is a separate, manual step; it has passed (see the status above).
