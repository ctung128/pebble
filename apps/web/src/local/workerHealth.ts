import type { WorkerHealth } from "@pebble/schema";
import { WorkerError, type WorkerClient } from "./workerClient.ts";

/** Jobs and health as used here need contract 1.2 or newer (within major 1). */
export const REQUIRED_SCHEMA_MINOR = 2;

export type WorkerStatus =
  | { kind: "checking" }
  | { kind: "ready"; health: WorkerHealth }
  | { kind: "not-running" }
  | { kind: "version-mismatch"; detail: string }
  | { kind: "needs-ffmpeg"; missing: string[] }
  | { kind: "data-dir"; path: string | null; hint: string | null }
  | { kind: "provider-unavailable"; detail: string | null }
  | { kind: "origin-blocked" };

/**
 * Asks the worker for /health and decides whether local processing can be offered.
 * Order matters: the first problem a learner must fix is the one reported.
 */
export async function checkWorker(client: WorkerClient): Promise<WorkerStatus> {
  let result;
  try {
    result = await client.health();
  } catch (error) {
    if (error instanceof WorkerError && error.code === "ORIGIN_NOT_ALLOWED") {
      return { kind: "origin-blocked" };
    }
    return { kind: "not-running" };
  }

  if (!result.ok) {
    return {
      kind: "version-mismatch",
      detail:
        result.code === "UNSUPPORTED_VERSION"
          ? "The worker speaks a newer or older data format than this app."
          : "The worker's status report isn't in the format this app expects.",
    };
  }
  const health = result.data;
  const minor = Number(health.schemaVersion.split(".")[1]);
  if (minor < REQUIRED_SCHEMA_MINOR) {
    return {
      kind: "version-mismatch",
      detail: `The worker (${health.workerVersion}, data format ${health.schemaVersion}) is older than this app needs (1.${REQUIRED_SCHEMA_MINOR} or newer).`,
    };
  }

  const missing = (["ffmpeg", "ffprobe"] as const).filter((tool) => !health.tools[tool].available);
  if (missing.length > 0) return { kind: "needs-ffmpeg", missing };

  if (!health.dataDirWritable || health.dataDir?.writable === false) {
    return {
      kind: "data-dir",
      path: health.dataDir?.path ?? null,
      hint: health.dataDir?.hint ?? null,
    };
  }

  const mock = health.providers.find((p) => p.id === "mock");
  if (!mock?.available) return { kind: "provider-unavailable", detail: mock?.detail ?? null };

  return { kind: "ready", health };
}
