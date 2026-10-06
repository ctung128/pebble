import type { Job } from "@pebble/schema";

/**
 * Progress details for the processing page, from real data only: the job's own fields, the
 * clock, and section completions this page saw happen. The one derived value, the time
 * estimate, is labelled as an estimate wherever it shows.
 */

/** A section completion this page observed: the count reached `n` at time `at` (ms). */
export interface SectionChange {
  n: number;
  at: number;
}

/** How many observed completions an estimate needs before it shows. */
export const ESTIMATE_MIN_CHANGES = 2;

/** "3:07" for a running clock. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Time since the audio was added. Only for a job's first attempt: a retry keeps the original
 * creation time, so the clock would count the earlier attempt too.
 */
export function elapsedMs(job: Job, now: number): number | null {
  if (job.attempt !== 1) return null;
  const created = Date.parse(job.createdAt);
  return Number.isNaN(created) ? null : now - created;
}

/** "42 min of audio · 17 sections", from what the worker has measured so far. */
export function contextLine(job: Job): string | null {
  const parts: string[] = [];
  if (job.durationMs) {
    const minutes = Math.round(job.durationMs / 60_000);
    parts.push(minutes >= 1 ? `${minutes} min of audio` : "Under a minute of audio");
  }
  if (job.progress) {
    const n = job.progress.totalChunks;
    parts.push(`${n} ${n === 1 ? "section" : "sections"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * "About 4 min left", from the average time between section completions this page saw.
 * Null until it has seen enough of them, outside the section stage, or once every section is
 * done (assembling is quick and has no count to measure).
 */
export function estimateLeft(job: Job, changes: readonly SectionChange[], now: number) {
  if (job.status !== "running" || job.stage !== "transcribing" || !job.progress) return null;
  const { completedChunks, totalChunks } = job.progress;
  const remaining = totalChunks - completedChunks;
  if (remaining <= 0 || changes.length < ESTIMATE_MIN_CHANGES) return null;
  const first = changes[0]!;
  const last = changes[changes.length - 1]!;
  if (last.n <= first.n) return null;
  const perSection = (last.at - first.at) / (last.n - first.n);
  // The current section is already part done; never count it below zero.
  const leftMs = Math.max(
    perSection * remaining - (now - last.at),
    perSection * (remaining - 1),
    0,
  );
  if (leftMs < 60_000) return "Less than a minute left";
  return `About ${Math.ceil(leftMs / 60_000)} min left`;
}

/** The tab title: progress at a glance while the page is in a background tab. */
export function tabTitle(job: Job, finished: boolean): string {
  const name = `${job.episodeTitle} · Pebble`;
  if (finished) return `✓ ${name}`;
  if (job.status === "failed") return `! ${name}`;
  if (job.status === "cancelled") return `Cancelled · ${name}`;
  if (job.status === "running" && job.stage === "transcribing" && job.progress) {
    return `(${job.progress.completedChunks}/${job.progress.totalChunks}) ${name}`;
  }
  return `Processing · ${name}`;
}
