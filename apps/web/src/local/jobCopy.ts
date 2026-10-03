import type { Job, JobStage } from "@pebble/schema";

/** Learner-facing stage names. Deliberately never "transcribing": the mock doesn't listen. */
export const STAGE_STEPS: { stage: JobStage; label: string }[] = [
  { stage: "probing", label: "Checking the audio file" },
  { stage: "normalizing", label: "Preparing the audio" },
  { stage: "chunking", label: "Finding natural break points" },
  { stage: "transcribing", label: "Processing sections" },
  { stage: "merging", label: "Assembling the preview transcript" },
];

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
      return STAGE_STEPS.find((s) => s.stage === job.stage)?.label ?? "Starting";
    case "completed":
      return "Processing preview finished";
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
