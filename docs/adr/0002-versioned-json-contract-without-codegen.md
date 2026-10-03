# ADR 0002 — Versioned JSON contract without code generation

**Status:** Accepted (2026-10-03)

## Context

Transcript and episode data will cross a language boundary (Python worker → TS app). Code
generation (Pydantic → JSON Schema → TypeScript) keeps types in sync but adds tooling that
would block early milestones.

## Decision

- A documented, versioned JSON contract in `packages/schema/CONTRACT.md`.
- Zod schemas in TypeScript now; Pydantic models in Python from M0C.
- Shared example payloads in `packages/schema/examples/{valid,invalid}`; both validators must
  accept every valid example and reject every invalid one with the expected issue.
- `schemaVersion` is `MAJOR.MINOR`; readers accept any `1.x` and ignore unknown fields.

## Consequences

- Two hand-written validators can drift; the shared example tests are the guard.
- Revisit code generation if the contract grows enough that drift becomes a real cost.
