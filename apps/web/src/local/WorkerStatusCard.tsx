import type { ReactNode } from "react";
import {
  CONFIGURATION_MISMATCH,
  FUNASR_CHECKING,
  FUNASR_NEEDS_SETUP,
  LOCAL_COPY,
} from "./providerCopy.ts";
import type { WorkerStatus } from "./workerHealth.ts";
import styles from "./local.module.css";

interface WorkerStatusCardProps {
  status: WorkerStatus;
  onRecheck: () => void;
  /** False shows nothing once Pebble is ready (the Library); the Add audio page keeps the line. */
  showReady?: boolean;
}

/**
 * Pebble's local state in plain language, and only what the learner can act on. Versions,
 * tool names, worker hints, paths and raw errors never appear; the terminal steps that fix a
 * problem sit behind "Show setup steps".
 */
export function WorkerStatusCard({ status, onRecheck, showReady = true }: WorkerStatusCardProps) {
  if (status.kind === "checking") {
    return (
      <p className={styles.readyLine} role="status" aria-live="polite">
        Checking Pebble…
      </p>
    );
  }

  if (status.kind === "provider-checking") {
    return (
      <p className={styles.readyLine} role="status" aria-live="polite">
        <span className={styles.readyTitle}>{FUNASR_CHECKING}</span> Pebble checks again on its own.
      </p>
    );
  }

  if (status.kind === "ready") {
    if (!showReady) return null;
    const copy = LOCAL_COPY[status.mode];
    // Nothing needs doing: one quiet line instead of a card.
    return (
      <p className={styles.readyLine} role="status" aria-live="polite">
        <span className={styles.readyTitle}>{copy.readyTitle}</span>{" "}
        <span>{copy.readyCapability}</span>
      </p>
    );
  }

  const { title, body, steps } = PROBLEMS[status.kind](status as never);
  return (
    <section className={styles.status} data-tone="problem" role="alert">
      <p className={styles.statusTitle}>{title}</p>
      <p className={styles.statusBody}>{body}</p>
      <details className={styles.setupSteps}>
        <summary>Show setup steps</summary>
        <ol>
          {steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      </details>
      <button type="button" className={styles.secondaryButton} onClick={onRecheck}>
        Check again
      </button>
    </section>
  );
}

type Problem = Exclude<
  WorkerStatus,
  { kind: "checking" } | { kind: "ready" } | { kind: "provider-checking" }
>;

/** A terminal command, shown as code. */
function Cmd({ children }: { children: string }) {
  return <code>{children}</code>;
}

const RESTART: ReactNode = (
  <>
    Stop Pebble with <Cmd>npm run pebble:stop</Cmd>, then start it again with{" "}
    <Cmd>npm run pebble:start</Cmd> from the Pebble folder.
  </>
);

/** Plain-language title and next step for each state, plus the setup steps behind a disclosure. */
const PROBLEMS: {
  [K in Problem["kind"]]: (status: Extract<Problem, { kind: K }>) => {
    title: string;
    body: string;
    steps: ReactNode[];
  };
} = {
  "not-running": () => ({
    title: "Pebble isn't running on this computer.",
    body: "Start Pebble, and this page will update on its own.",
    steps: [
      <>
        In a terminal, from the Pebble folder, run <Cmd>npm run pebble:start</Cmd>.
      </>,
      <>
        If it says Pebble isn't set up yet, run <Cmd>npm run pebble:setup</Cmd> first.
      </>,
    ],
  }),
  "needs-ffmpeg": () => ({
    title: "Pebble needs one more setup step before it can process audio.",
    body: "Finish setting up Pebble, then check again.",
    steps: [
      <>
        Run <Cmd>npm run pebble:setup</Cmd> and follow its instructions, or install FFmpeg with{" "}
        <Cmd>brew install ffmpeg</Cmd>.
      </>,
      <>
        Confirm the setup with <Cmd>npm run pebble:doctor</Cmd>.
      </>,
      RESTART,
    ],
  }),
  "version-mismatch": () => ({
    title: "Pebble needs a restart.",
    body: "This page and the running copy of Pebble don't match. Restart Pebble, then reload this page.",
    steps: [RESTART, "Reload this page."],
  }),
  "data-dir": () => ({
    title: "Pebble can't save files on this computer.",
    body: "Pebble's data folder is missing or can't be written to.",
    steps: [
      "Check that Pebble's data folder exists and that you can write to it.",
      <>
        Or choose another folder with <Cmd>PEBBLE_DATA_DIR</Cmd>.
      </>,
      RESTART,
    ],
  }),
  "provider-setup": () => ({
    title: FUNASR_NEEDS_SETUP,
    body: "Finish setting up Pebble, then check again.",
    steps: [
      <>
        Run <Cmd>npm run pebble:setup</Cmd> and follow its instructions.
      </>,
      RESTART,
    ],
  }),
  "provider-unavailable": ({ mode }) => ({
    title: LOCAL_COPY[mode].unavailableHeading,
    body: "Restart Pebble. If that doesn't help, check the setup.",
    steps: [
      RESTART,
      <>
        For details, run <Cmd>npm run pebble:doctor</Cmd>.
      </>,
    ],
  }),
  "provider-mismatch": () => ({
    title: CONFIGURATION_MISMATCH,
    body: "Restart Pebble from this Pebble folder, then check again.",
    steps: [RESTART],
  }),
  "origin-blocked": () => ({
    title: "Pebble can't connect from this page.",
    body: "Open Pebble from the address it gives you when it starts.",
    steps: [
      <>
        Start Pebble with <Cmd>npm run pebble:start</Cmd> and open <Cmd>http://localhost:5175</Cmd>.
      </>,
      <>
        To use another address, add it to <Cmd>PEBBLE_ALLOWED_ORIGINS</Cmd> and restart Pebble.
      </>,
    ],
  }),
};
