import type { Job, JobFailure, JobStage } from "@pebble/schema";
import { LOCAL_COPY, modeForJob, type LocalMode } from "./providerCopy.ts";

export interface StageStep {
  stage: JobStage;
  label: string;
}

/**
 * Learner-facing stage names for the job's provider. Deliberately never "transcribing" for
 * the mock, which doesn't listen.
 */
export function stageSteps(mode: LocalMode): StageStep[] {
  return [
    { stage: "probing", label: "Checking the audio file" },
    { stage: "normalizing", label: "Preparing the audio" },
    { stage: "chunking", label: "Finding natural break points" },
    { stage: "transcribing", label: "Processing sections" },
    { stage: "merging", label: LOCAL_COPY[mode].finalStageLabel },
  ];
}

/** Mock-mode stages (unchanged since M0C). */
export const STAGE_STEPS: StageStep[] = stageSteps("mock");

export const TERMINAL_STATUSES = new Set<Job["status"]>(["completed", "failed", "cancelled"]);

export function isActive(job: Job): boolean {
  return job.status === "queued" || job.status === "running";
}

export function canRetry(job: Job): boolean {
  return job.status === "cancelled" || (job.status === "failed" && job.failure?.retryable === true);
}

/**
 * What an active job is doing, from real data only: "Processing section N of M" once the
 * worker reports section counts, otherwise a neutral stage. Never a percentage, a time
 * estimate or an internal step name.
 */
export function activityLabel(job: Job): string {
  if (job.status === "queued") return "Waiting to start…"; // e.g. behind another episode
  if (job.status === "running" && job.stage === "transcribing") {
    if (!job.progress) return "Processing audio…";
    const { completedChunks, totalChunks } = job.progress;
    return `Processing section ${Math.min(completedChunks + 1, totalChunks)} of ${totalChunks}`;
  }
  if (job.status === "running" && job.stage === "merging") return "Processing audio…";
  return "Preparing audio…"; // checking, preparing or splitting the audio
}

export function statusLabel(job: Job): string {
  switch (job.status) {
    case "queued":
    case "running":
      return activityLabel(job);
    case "completed":
      return LOCAL_COPY[modeForJob(job)].completedStatus;
    case "failed":
      return "Couldn't process this audio";
    case "cancelled":
      return "Cancelled";
  }
}

export interface FailureCopy {
  /** What went wrong, in plain words. */
  reason: string;
  /** The one next step. */
  next: string;
}

const SETUP = "Pebble isn't fully set up on this computer.";
const RUN_SETUP = "Run Pebble's setup, then try again.";
const SOMETHING_WRONG: FailureCopy = {
  reason: "Something went wrong while processing.",
  next: "Try again. If it keeps happening, restart Pebble.",
};

/**
 * Safe, learner-facing copy for each failure code. The worker's own message, hint and code
 * never reach the UI: they can carry tool names, paths or internals.
 */
export const FAILURE_COPY: Record<JobFailure["code"], FailureCopy> = {
  FFMPEG_NOT_FOUND: { reason: SETUP, next: RUN_SETUP },
  PROVIDER_UNAVAILABLE: { reason: SETUP, next: RUN_SETUP },
  UNSUPPORTED_MEDIA: {
    reason: "This file type isn't supported.",
    next: "Try an MP3, M4A or WAV file.",
  },
  NO_AUDIO_STREAM: {
    reason: "This file doesn't contain any audio.",
    next: "Choose a file with audio in it.",
  },
  AUDIO_TOO_LONG: {
    reason: "This audio is longer than Pebble can process.",
    next: "Try a shorter file.",
  },
  STORAGE_ERROR: {
    reason: "Pebble couldn't save its work on this computer.",
    next: "Check that there's free disk space, then try again.",
  },
  PROVIDER_ERROR: SOMETHING_WRONG,
  NO_SPEECH_DETECTED: {
    reason: "No speech was found in this audio.",
    next: "Choose a file with Mandarin speech in it.",
  },
  WORKER_RESTARTED: {
    reason: "Pebble stopped before processing finished.",
    next: "Try again to restart processing.",
  },
  CANCELLED: { reason: "Processing was cancelled.", next: "Try again to start over." },
  INTERNAL_ERROR: SOMETHING_WRONG,
};

export function failureCopy(job: Job): FailureCopy {
  return (job.failure && FAILURE_COPY[job.failure.code]) ?? SOMETHING_WRONG;
}

/**
 * Plain copy for a failed request to the worker. Its message can carry internals, so only
 * known codes get specific words; anything else gets the caller's generic fallback.
 */
export function requestProblem(code: string, fallback: string): string {
  switch (code) {
    case "UNREACHABLE":
      return "Pebble isn't responding. Check that it's running, then try again.";
    case "JOB_ACTIVE":
      return "This episode is still processing.";
    default:
      return fallback;
  }
}
