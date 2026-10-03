/**
 * Contract versioning. `schemaVersion` is "MAJOR.MINOR".
 * Readers accept any minor within the supported major and ignore unknown fields;
 * a different major is rejected as unsupported.
 */
export const SUPPORTED_MAJOR = 1;
export const CURRENT_SCHEMA_VERSION = "1.2";

const VERSION_PATTERN = /^(\d+)\.(\d+)$/;

export type VersionCheck =
  | { ok: true; major: number; minor: number }
  | { ok: false; reason: "missing" | "malformed" | "unsupported"; found: unknown };

export function checkSchemaVersion(payload: unknown): VersionCheck {
  const found =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).schemaVersion
      : undefined;
  if (found === undefined) return { ok: false, reason: "missing", found };
  if (typeof found !== "string") return { ok: false, reason: "malformed", found };
  const match = VERSION_PATTERN.exec(found);
  if (!match) return { ok: false, reason: "malformed", found };
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== SUPPORTED_MAJOR) return { ok: false, reason: "unsupported", found };
  return { ok: true, major, minor };
}
