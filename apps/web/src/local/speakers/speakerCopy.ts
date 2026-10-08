/**
 * Learner-facing copy for local speaker labels (ADR 0009). Local mode only: none of it may reach
 * the demo bundle (demoBundleGuard.mjs checks the distinctive phrases). The worker's own messages
 * are never shown; every refusal maps to the fixed copy here.
 */

export const SPEAKERS = {
  heading: "Speakers",
  badge: "Experimental",
  notDetected: "Not detected",
  detecting: "Detecting…",
  summary: (speakers: number, lines: number) =>
    `${speakers === 1 ? "1 speaker" : `${speakers} speakers`} · ${lines === 1 ? "1 line" : `${lines} lines`}`,
  detect: "Detect speakers",
  detectAgain: "Detect speakers again",
  starting: "Starting…",
  cancel: "Cancel detection",
  advanced: "Advanced",
  hintLabel: "Expected number of speakers (optional)",
  hintHelp: "Leave empty to let Pebble decide. Use 1–15.",
  hintProblem: "Use a whole number from 1 to 15, or leave it empty.",
  checkAgain: "Check again",
  keyHeading: "Speakers in this episode",
  nameLabel: (letter: string) => `Name for speaker ${letter}`,
  namePlaceholder: "Add a name",
  lineCount: (n: number) => (n === 1 ? "1 line" : `${n} lines`),
  notSpeaker: "Not a speaker",
  actionsLabel: (letter: string) => `Actions for speaker ${letter}`,
  mergeInto: (letter: string, name: string) =>
    name ? `Merge into ${letter} (${name})` : `Merge into ${letter}`,
  mergePrompt: (from: string, into: string) =>
    `Show all of speaker ${from}'s lines as speaker ${into}?`,
  mergeConfirm: "Merge speakers",
  mergeCancel: "Cancel",
  mergedRow: (from: string, into: string) => `${from} is shown as ${into}`,
  hiddenRow: (letter: string) => `${letter} is marked not a speaker`,
  undo: "Undo",
  undoLabel: (row: string) => `Undo: ${row}`,
  locked: "Others were merged into this speaker; undo those merges first.",
  correctLines: "Correct lines",
  doneCorrecting: "Done correcting lines",
  lineSelectLabel: (time: string) => `Speaker for line at ${time}`,
  asDetected: (letter: string | null) =>
    letter ? `As detected (${letter})` : "As detected (none)",
  lineNotSpeaker: "Not a speaker",
  save: "Save speaker changes",
  saving: "Saving…",
  saved: "Speaker changes saved.",
  savedTucked:
    "Speaker changes saved. To change them again, choose Edit speaker settings in the transcript actions menu.",
  showPanel: "Edit speaker settings",
  hidePanel: "Hide speakers",
  unsaved: "You have unsaved speaker changes.",
  cantSave: "Some changes can't be saved together. Check the names and merges.",
} as const;

export const SPEAKER_STATUS = {
  queued: "Waiting to detect speakers…",
  running: "Detecting speakers… This can take several minutes for a long episode.",
  done: "Speakers detected.",
  cancelled: "Speaker detection was cancelled.",
  pollStopped: "Still detecting. Check again in a while.",
} as const;

/** Why new detection can't start here, by health's `speakers.state`. */
export const SPEAKER_UNAVAILABLE = {
  model_missing:
    "Speaker detection isn't set up on this computer. Download the speaker model with: npm run worker:models -- pull --speaker",
  model_incomplete:
    "The speaker model is incomplete. Download it again with: npm run worker:models -- pull --speaker",
  isolation_unavailable:
    "Speaker detection needs macOS's built-in sandbox, which isn't available here.",
  keepReadable: "Speaker labels you already have stay readable.",
} as const;

/** A finished run that didn't produce speakers, by the worker's fixed failure code. */
export function speakerFailure(code: string): string {
  switch (code) {
    case "SPEAKER_MODEL_UNAVAILABLE":
      return SPEAKER_UNAVAILABLE.model_missing;
    case "NETWORK_ISOLATION_FAILED":
      return "Speaker detection didn't start because Pebble couldn't keep it offline.";
    case "AUDIO_UNAVAILABLE":
      return "This episode's audio couldn't be read for speaker detection.";
    case "TIMED_OUT":
      return "Speaker detection took too long and was stopped.";
    case "CANCELLED":
      return SPEAKER_STATUS.cancelled;
    case "WORKER_RESTARTED":
      return "Pebble stopped while detecting speakers. You can detect them again.";
    case "TRANSCRIPT_CHANGED":
      return "The transcript changed during detection, so that result wasn't used.";
    default:
      return "Speaker detection didn't finish. You can try again.";
  }
}

/** A refused request, by the worker's error code. Never the worker's own message. */
export function speakerRequestProblem(code: string): string {
  switch (code) {
    case "SPEAKER_RUN_ACTIVE":
      return "Speakers are already being detected for this episode.";
    case "SPEAKER_MODEL_UNAVAILABLE":
      return SPEAKER_UNAVAILABLE.model_missing;
    case "SPEAKER_ISOLATION_UNAVAILABLE":
      return SPEAKER_UNAVAILABLE.isolation_unavailable;
    case "AUDIO_UNAVAILABLE":
      return "This episode's audio is no longer available.";
    case "SPEAKERS_NOT_ELIGIBLE":
      return "Speaker detection needs a real transcript of this episode.";
    case "SPEAKER_CORRECTIONS_STALE":
      return SPEAKER_CONFLICT_CHOOSE(1);
    case "SPEAKER_RUN_MISMATCH":
    case "SPEAKER_RUN_NOT_COMPLETED":
      return SPEAKER_NOT_CARRIED;
    case "SPEAKER_CORRECTIONS_INVALID":
      return SPEAKERS.cantSave;
    case "UNREACHABLE":
      return "Pebble's local worker isn't running. Start it with npm run pebble:start.";
    default:
      return "That didn't work. Try again.";
  }
}

/** Revision conflicts (another tab or browser saved first). Never saved without a decision. */
export const SPEAKER_CONFLICT_COMBINED =
  "These speakers were also changed somewhere else. Those changes were combined with yours. Review them, then save.";
export const SPEAKER_CONFLICT_CHOOSE = (count: number) =>
  `These speakers were also changed somewhere else, and ${count === 1 ? "1 change clashes" : `${count} changes clash`} with yours. Keep your version or use the saved one.`;
/** "Keep my version" keeps my whole draft: saving it replaces the entire saved set. */
export const SPEAKER_CONFLICT_KEPT =
  "Your version is kept. Saving it replaces all of the saved speaker changes, including ones that didn't clash with yours.";
export const SPEAKER_CONFLICT_DISCARDED = "Your changes were discarded. Showing the saved version.";
export const SPEAKER_CONFLICT_ACTIONS = {
  keepMine: "Keep my version",
  useSaved: "Use the saved version",
} as const;

export const SPEAKER_NOT_CARRIED =
  "New speakers were detected. Names and corrections from the earlier detection weren't carried over, because speaker letters can change.";

export const SPEAKER_UNSAVED_DROPPED =
  "New speakers were detected. Your unsaved changes were for the earlier detection and weren't kept.";
