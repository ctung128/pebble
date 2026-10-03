# ADR 0004 — Learner data is browser-owned for now

**Status:** Accepted (2026-10-03)

## Context

M0B adds corrections and learning items. The public demo has no worker, and the local worker
(M0C) doesn't exist yet. Corrections conceptually belong with transcripts, which the worker
will own.

## Decision

- For M0B, a browser-side `LearningStore` owns corrections and learning items: IndexedDB in the
  browser, an in-memory implementation in tests.
- The store interface stays small (list/put/delete/clear) so it can be replaced.
- If storage is unavailable or a write fails, the app continues with session-only data and
  shows a non-blocking notice.
- Demo visitors' data stays in their own browser; "Reset demo data" clears it.
- Moving or synchronizing learner data to worker-owned SQLite is a planned M0C+ decision. No
  sync, migration or second storage abstraction is built now.

## Consequences

- Corrections made in the demo don't travel with transcripts; in local mode (M0C+) they will
  need a migration path or a decision to keep them browser-side.
- Data is per browser profile and can be cleared by the user or browser.
