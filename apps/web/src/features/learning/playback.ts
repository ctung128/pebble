/**
 * Browser-local listening progress for one episode. Learner state only: it stays in this
 * browser (IndexedDB, or memory when that's unavailable), never reaches the worker, exports
 * or the public demo's data, and holds nothing but these values.
 */
export interface PlaybackRecord {
  episodeId: string;
  /** Where listening stopped. */
  positionMs: number;
  /** The episode's length when saved, to check the record still fits the episode. */
  durationMs: number;
  updatedAt: string;
  /** Set only by the audio's real `ended` event; null otherwise. */
  finishedAt: string | null;
}

/** Below this, there's nothing worth resuming (and the episode counts as not started). */
export const MIN_RESUME_MS = 5_000;
/** A record whose duration differs by more than this no longer describes the episode. */
export const DURATION_TOLERANCE_MS = 2_000;

const KEYS = ["episodeId", "positionMs", "durationMs", "updatedAt", "finishedAt"] as const;
const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isDate = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

/**
 * A stored row as a record, or null when it isn't exactly one: the five fields and nothing
 * else (so a row can't smuggle other data in), all well-formed.
 */
export function parsePlaybackRecord(row: unknown): PlaybackRecord | null {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
  const value = row as Record<string, unknown>;
  if (Object.keys(value).some((key) => !(KEYS as readonly string[]).includes(key))) return null;
  const { episodeId, positionMs, durationMs, updatedAt, finishedAt } = value;
  if (typeof episodeId !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(episodeId)) return null;
  if (!isTime(positionMs) || !isTime(durationMs) || durationMs === 0) return null;
  if (positionMs > durationMs + DURATION_TOLERANCE_MS) return null;
  if (!isDate(updatedAt) || !(finishedAt === null || isDate(finishedAt))) return null;
  return { episodeId, positionMs, durationMs, updatedAt, finishedAt };
}

export type ListeningState = "not-started" | "in-progress" | "finished";

/**
 * What a record says about an episode of the given length: finished only after a real
 * `ended`; in progress from 5 s; otherwise (or if the record no longer fits) not started.
 */
export function listeningState(
  record: PlaybackRecord | null | undefined,
  durationMs: number | null | undefined,
): ListeningState {
  if (!record || !fitsEpisode(record, durationMs)) return "not-started";
  if (record.finishedAt) return "finished";
  return record.positionMs >= MIN_RESUME_MS ? "in-progress" : "not-started";
}

/** Whether a record still describes this episode (same length, position inside it). */
export function fitsEpisode(record: PlaybackRecord, durationMs: number | null | undefined) {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
    return false;
  }
  return (
    Math.abs(record.durationMs - durationMs) <= DURATION_TOLERANCE_MS &&
    record.positionMs <= durationMs + DURATION_TOLERANCE_MS
  );
}
