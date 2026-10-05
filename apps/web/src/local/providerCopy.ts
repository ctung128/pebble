import type { Job } from "@pebble/schema";

/**
 * The two transcription providers this app knows. The worker runs exactly one of them;
 * anything else is a configuration mismatch, never "ready".
 */
export type LocalMode = "mock" | "funasr";

/** Worker provider `{ id, kind }` → mode, or null for an unknown or inconsistent provider. */
export function modeForProvider(provider: { id: string; kind: string }): LocalMode | null {
  if (provider.id === "mock" && provider.kind === "mock") return "mock";
  if (provider.id === "funasr" && provider.kind === "asr") return "funasr";
  return null;
}

/** Mode for a job, from the provider recorded on it. */
export function modeForJob(job: Job): LocalMode {
  return job.provider.kind === "asr" ? "funasr" : "mock";
}

export interface LocalCopy {
  uploadHeading: string;
  uploadDescription: string;
  submitLabel: string;
  progressEyebrow: string;
  finalStageLabel: string;
  completedStatus: string;
  openAction: string;
  checkingTranscript: string;
  unreadableTranscript: string;
  readyTitle: string;
  readyCapability: string;
  unavailableHeading: string;
}

export const LOCAL_COPY: Record<LocalMode, LocalCopy> = {
  mock: {
    uploadHeading: "Process audio locally",
    uploadDescription:
      "This preview prepares your audio on this computer and creates placeholder transcript text for testing.",
    submitLabel: "Run processing preview",
    progressEyebrow: "Preparing processing preview",
    finalStageLabel: "Assembling the preview transcript",
    completedStatus: "Processing preview finished",
    openAction: "Open preview transcript",
    checkingTranscript: "Checking the preview transcript…",
    unreadableTranscript: "Finished, but the preview transcript couldn't be read",
    readyTitle: "Processing preview is ready.",
    readyCapability: "It creates placeholder text for testing, not a transcript.",
    unavailableHeading: "Pebble's processing preview isn't available.",
  },
  funasr: {
    uploadHeading: "Create a transcript locally",
    uploadDescription:
      "Pebble processes your audio on this computer and creates a timestamped Mandarin transcript.",
    submitLabel: "Create transcript",
    progressEyebrow: "Creating your transcript",
    finalStageLabel: "Assembling the transcript",
    completedStatus: "Transcript finished",
    openAction: "Open transcript",
    checkingTranscript: "Checking the transcript…",
    unreadableTranscript: "Finished, but the transcript couldn't be read",
    readyTitle: "Local transcription is ready.",
    readyCapability: "Pebble transcribes Mandarin audio on this computer.",
    unavailableHeading: "Pebble's local transcription isn't available.",
  },
};

export const FUNASR_CHECKING = "Checking local speech models…";
export const FUNASR_NEEDS_SETUP = "Pebble's local transcription needs setup.";
export const CONFIGURATION_MISMATCH = "Pebble's setup doesn't match this page.";
