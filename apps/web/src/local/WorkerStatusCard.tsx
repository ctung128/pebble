import type { ReactNode } from "react";
import type { WorkerStatus } from "./workerHealth.ts";
import styles from "./local.module.css";

interface WorkerStatusCardProps {
  status: WorkerStatus;
  onRecheck: () => void;
}

/** Explains the local worker's state and, when something is wrong, the exact next step. */
export function WorkerStatusCard({ status, onRecheck }: WorkerStatusCardProps) {
  if (status.kind === "checking") {
    return (
      <section className={styles.status} data-tone="neutral" role="status" aria-live="polite">
        <p className={styles.statusTitle}>Checking Pebble's local worker…</p>
      </section>
    );
  }

  if (status.kind === "ready") {
    const { tools } = status.health;
    return (
      <section className={styles.status} data-tone="ok" role="status" aria-live="polite">
        <p className={styles.statusTitle}>Local worker is ready.</p>
        <p className={styles.statusBody}>
          FFmpeg {tools.ffmpeg.version} · Processing preview (placeholder transcript text) · worker{" "}
          {status.health.workerVersion}
        </p>
      </section>
    );
  }

  const { title, body } = PROBLEMS[status.kind](status as never);
  return (
    <section className={styles.status} data-tone="problem" role="alert">
      <p className={styles.statusTitle}>{title}</p>
      <div className={styles.statusBody}>{body}</div>
      <button type="button" className={styles.secondaryButton} onClick={onRecheck}>
        Check again
      </button>
    </section>
  );
}

type Problem = Exclude<WorkerStatus, { kind: "checking" } | { kind: "ready" }>;

const PROBLEMS: {
  [K in Problem["kind"]]: (status: Extract<Problem, { kind: K }>) => {
    title: string;
    body: ReactNode;
  };
} = {
  "not-running": () => ({
    title: "Pebble's local worker is not running.",
    body: (
      <>
        <p>In a terminal, from the Pebble folder, run:</p>
        <pre className={styles.command}>
          <code>npm run worker</code>
        </pre>
        <p>Pebble checks again automatically every few seconds.</p>
      </>
    ),
  }),
  "needs-ffmpeg": ({ missing }) => ({
    title: "Audio processing needs FFmpeg.",
    body: (
      <>
        <p>
          The worker can't find {missing.join(" and ")}. Install FFmpeg, then confirm the setup:
        </p>
        <pre className={styles.command}>
          <code>{"brew install ffmpeg\nnpm run worker:doctor"}</code>
        </pre>
        <p>Restart the worker after the doctor reports all checks passed.</p>
      </>
    ),
  }),
  "version-mismatch": ({ detail }) => ({
    title: "Pebble's app and worker versions do not match.",
    body: (
      <>
        <p>{detail}</p>
        <p>
          Stop the worker, then start it again from this same Pebble folder with{" "}
          <code>npm run worker</code> and reload this page. If you updated Pebble, run{" "}
          <code>npm install</code> first.
        </p>
      </>
    ),
  }),
  "data-dir": ({ path, hint }) => ({
    title: "Pebble cannot access its local data folder.",
    body: (
      <>
        {path ? (
          <p>
            Data folder: <code>{path}</code>
          </p>
        ) : null}
        <p>
          {hint ??
            "Check that the folder exists and you can write to it, or choose another location with PEBBLE_DATA_DIR, then restart the worker."}
        </p>
      </>
    ),
  }),
  "provider-unavailable": ({ detail }) => ({
    title: "Pebble's processing preview isn't available.",
    body: (
      <>
        {detail ? <p>{detail}</p> : null}
        <p>
          Run <code>npm run worker:doctor</code> for details, then restart the worker.
        </p>
      </>
    ),
  }),
  "origin-blocked": () => ({
    title: "The local worker didn't accept this page.",
    body: (
      <p>
        Open Pebble's local mode at <code>http://localhost:5175</code> (
        <code>npm run dev:local</code>), or add this page's address to{" "}
        <code>PEBBLE_ALLOWED_ORIGINS</code> and restart the worker.
      </p>
    ),
  }),
};
