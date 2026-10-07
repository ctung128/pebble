# English line translation (DeepL)

> **Status: design approved ([ADR 0008](adr/0008-optional-deepl-line-translation.md)); not
> available yet.** English stays hidden for local real-ASR transcripts until it ships. Live
> DeepL calls, including a smoke test, still require separate approval. This page is the
> specification the implementation and its tests follow.
>
> **Built so far:** the settings below, the worker's translation tables (database migration 2) and the consent routes. Translation requests aren't implemented, so `/health` doesn't
> report translation yet and nothing can be translated.

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
English tap on a configured worker without current consent opens the dialog; **Translate**
records consent and sends that one line, **Cancel** sends nothing.

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

## Reading English

- **Cache.** Worker SQLite holds every translation, owned by its episode (deleted with it),
  keyed by episode, segment, source fingerprint (SHA-256 of the exact submitted text),
  provider, target language and cache version (1: DeepL, `EN-US`, no context, NFC rules v1).
  Nothing is cached in the browser beyond the open page.
- **Current or stale.** English whose fingerprint matches the line as displayed is current.
  If none matches, the newest row for that line (latest `created_at`, then highest row id) is
  shown as "English for an earlier version of this line" with **Translate again**, which is
  an explicit request. Reverting an edit makes its earlier translation current again.
- **Show saved English** (beside the pinyin toggle) reveals current cached English only; it
  never requests anything.
- Cached English stays readable when translation is off, consent is withdrawn or a limit is
  reached.
- **Saving** a learning item stores English only if it is current for the displayed text.
  **Export** uses saved snapshots and never calls DeepL for real-ASR items.

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

Reservations are never refunded. A reservation left behind by a crash may never have been
sent, so the counters are an upper bound on outbound attempts.

## Transport

Direct HTTPS to the fixed DeepL API host only, with certificate and hostname verification. No
redirects (any 3xx is a failure, so the key is never sent elsewhere), no proxies, a 10 s
timeout, a response of at most 64 KiB that must contain one non-empty translation of at most
2,000 code points. Translation routes keep the worker's Host and Origin checks and accept small
JSON bodies only (4 KiB; 1 KiB for consent).

## Errors

Fixed messages; DeepL's own responses are never shown or logged (the log records the code,
HTTP status and character count only).

| Situation                                     | Code                                      | Message                                                                                          |
| --------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Translation not set up                        | `TRANSLATION_OFF`                         | English isn't set up for Pebble on this computer.                                                |
| No current consent                            | `TRANSLATION_CONSENT_REQUIRED`            | (opens the consent dialog)                                                                       |
| Pebble's monthly limit                        | `TRANSLATION_LOCAL_LIMIT`                 | Pebble's monthly translation limit on this computer has been reached. Saved English still shows. |
| DeepL 429                                     | `TRANSLATION_RATE_LIMITED`                | DeepL is busy right now. Wait a moment, then tap English again.                                  |
| DeepL 456                                     | `TRANSLATION_PROVIDER_QUOTA`              | Your DeepL account's character allowance has been reached. Check your DeepL account.             |
| DeepL 403                                     | `TRANSLATION_KEY_REJECTED`                | DeepL didn't accept the key set up for Pebble.                                                   |
| DeepL 400 or 413                              | `TRANSLATION_REQUEST_REJECTED`            | DeepL couldn't translate this line.                                                              |
| 5xx, timeout, network, TLS, 3xx, bad response | `TRANSLATION_UNAVAILABLE`                 | Translation is unavailable right now. Try again later.                                           |
| Text fails the rules                          | `TRANSLATION_INVALID_TEXT`                | This line can't be translated.                                                                   |
| Demo, mock or incomplete transcript           | `TRANSLATION_NOT_ALLOWED`                 | (no action is shown)                                                                             |
| Unknown or deleted episode or line            | `EPISODE_NOT_FOUND` / `SEGMENT_NOT_FOUND` | This episode or line no longer exists.                                                           |

## Testing

Invented text, fake providers and a fake HTTPS transport only; no live DeepL test runs in the
suite. A live smoke test with one invented sentence is a separate, manual step.
