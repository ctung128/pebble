import type { z } from "zod";
import { ManifestSchema, type Manifest } from "./manifest.ts";
import { TranscriptSchema, type Transcript } from "./transcript.ts";
import { checkSchemaVersion, SUPPORTED_MAJOR } from "./version.ts";

export type ContractErrorCode = "INVALID_PAYLOAD" | "UNSUPPORTED_VERSION";

export interface ContractIssue {
  path: string;
  message: string;
}

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ContractErrorCode; message: string; issues: ContractIssue[] };

function parseWith<T>(schema: z.ZodType<T>, payload: unknown, label: string): ParseResult<T> {
  const version = checkSchemaVersion(payload);
  if (!version.ok) {
    const unsupported = version.reason === "unsupported";
    return {
      ok: false,
      code: unsupported ? "UNSUPPORTED_VERSION" : "INVALID_PAYLOAD",
      message: unsupported
        ? `${label} schemaVersion ${String(version.found)} is not supported (expected ${SUPPORTED_MAJOR}.x)`
        : `${label} schemaVersion is ${version.reason}`,
      issues: [{ path: "schemaVersion", message: version.reason }],
    };
  }

  const result = schema.safeParse(payload);
  if (result.success) return { ok: true, data: result.data };

  const issues = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
  const first = issues[0];
  return {
    ok: false,
    code: "INVALID_PAYLOAD",
    message: `${label} is invalid${first ? `: ${first.path || "(root)"} — ${first.message}` : ""}`,
    issues,
  };
}

export const parseManifest = (payload: unknown): ParseResult<Manifest> =>
  parseWith(ManifestSchema, payload, "Manifest");

export const parseTranscript = (payload: unknown): ParseResult<Transcript> =>
  parseWith(TranscriptSchema, payload, "Transcript");
