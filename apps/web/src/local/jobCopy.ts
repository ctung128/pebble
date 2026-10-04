import type { Job, JobStage } from "@pebble/schema";
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

export function statusLabel(job: Job): string {
  switch (job.status) {
    case "queued":
      return "Waiting to start";
    case "running":
      return stageSteps(modeForJob(job)).find((s) => s.stage === job.stage)?.label ?? "Starting";
    case "completed":
      return LOCAL_COPY[modeForJob(job)].completedStatus;
    case "failed":
      return "Processing stopped";
    case "cancelled":
      return "Cancelled";
  }
}

/** Real chunk counts only — never an estimated percentage. */
export function sectionProgress(job: Job): string | null {
  if (!job.progress) return null;
  const { completedChunks, totalChunks } = job.progress;
  if (job.status === "running" && job.stage === "transcribing") {
    return `Processing section ${Math.min(completedChunks + 1, totalChunks)} of ${totalChunks}`;
  }
  return `${completedChunks} of ${totalChunks} ${totalChunks === 1 ? "section" : "sections"} processed`;
}
