import type { ProviderState, WorkerHealth } from "@pebble/schema";
import { modeForProvider, type LocalMode } from "./providerCopy.ts";
import { WorkerError, type WorkerClient } from "./workerClient.ts";

/** Jobs and health as used here need contract 1.2 or newer (within major 1). */
export const REQUIRED_SCHEMA_MINOR = 2;

export type WorkerStatus =
  | { kind: "checking" }
  | { kind: "ready"; mode: LocalMode; health: WorkerHealth }
  | { kind: "not-running" }
  | { kind: "version-mismatch"; detail: string }
  | { kind: "needs-ffmpeg"; missing: string[] }
  | { kind: "data-dir"; path: string | null; hint: string | null }
  | { kind: "provider-checking"; mode: LocalMode }
  | { kind: "provider-setup"; mode: LocalMode; hint: string | null }
  | { kind: "provider-unavailable"; mode: LocalMode; hint: string | null }
  | { kind: "provider-mismatch" }
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

  // The worker lists exactly the provider it runs. Only the two this app knows can be ready.
  const [provider, ...others] = health.providers;
  const mode = provider && others.length === 0 ? modeForProvider(provider) : null;
  if (!provider || mode === null) return { kind: "provider-mismatch" };

  // Workers older than contract 1.5 don't send `state`: fall back to `available`.
  const state: ProviderState = provider.state ?? (provider.available ? "ready" : "load_failed");
  const hint = provider.hint ?? null; // `detail` is developer diagnostics, never shown here
  switch (state) {
    case "ready":
      return provider.available
        ? { kind: "ready", mode, health }
        : { kind: "provider-unavailable", mode, hint };
    case "checking":
      return { kind: "provider-checking", mode };
    case "environment_missing":
    case "models_missing":
    case "verification_failed":
      return mode === "funasr"
        ? { kind: "provider-setup", mode, hint }
        : { kind: "provider-unavailable", mode, hint };
    case "load_failed":
      return { kind: "provider-unavailable", mode, hint };
  }
}

/** The provider mode a status reports, if it reports one. */
export function statusMode(status: WorkerStatus): LocalMode | null {
  return "mode" in status ? status.mode : null;
}
