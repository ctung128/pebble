import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { Job } from "@pebble/schema";
import { StatusView } from "../components/StatusView.tsx";
import { useEpisodeSource } from "../data/SourceContext.tsx";
import { canRetry, isActive, sectionProgress, stageSteps, statusLabel } from "./jobCopy.ts";
import { LOCAL_COPY, modeForJob } from "./providerCopy.ts";
import { useJobPolling } from "./useJobPolling.ts";
import { WorkerError } from "./workerClient.ts";
import { useWorker } from "./WorkerContext.tsx";
import styles from "./local.module.css";

type Verification =
  { kind: "pending" } | { kind: "verified" } | { kind: "invalid"; message: string };

export function JobProgressRoute() {
  const { jobId = "" } = useParams();
  return <JobProgressPage key={jobId} jobId={jobId} />;
}

export function JobProgressPage({ jobId }: { jobId: string }) {
  const { client } = useWorker();
  const source = useEpisodeSource();
  const { job, error, restart } = useJobPolling(client, jobId);
  const [action, setAction] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });
  const [verification, setVerification] = useState<Verification>({ kind: "pending" });

  // "Completed" is only shown once the transcript itself loads and validates.
  const completedEpisode = job?.status === "completed" ? job.episodeId : null;
  useEffect(() => {
    if (!completedEpisode) return;
    let cancelled = false;
    source.getTranscript(completedEpisode).then(
      () => !cancelled && setVerification({ kind: "verified" }),
      (caught: unknown) =>
        !cancelled &&
        setVerification({
          kind: "invalid",
          message: caught instanceof Error ? caught.message : "The transcript couldn't be read.",
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [completedEpisode, source]);

  const run = async (operation: () => Promise<Job>) => {
    setAction({ busy: true, error: null });
    try {
      await operation();
      setVerification({ kind: "pending" });
      restart();
      setAction({ busy: false, error: null });
    } catch (caught) {
      setAction({
        busy: false,
        error: caught instanceof WorkerError ? caught.message : "That didn't work. Try again.",
      });
    }
  };

  if (!job) {
    if (error) {
      return (
        <div className={styles.page}>
          <BackToLibrary />
          <StatusView
            kind="error"
            title={error.code === "NOT_FOUND" ? "Job not found" : "Can't reach the local worker"}
            message={
              error.code === "NOT_FOUND" ? "This processing job doesn't exist." : error.message
            }
          />
        </div>
      );
    }
    return <StatusView kind="loading" title="Loading processing status…" />;
  }

  const copy = LOCAL_COPY[modeForJob(job)];
  const steps = stageSteps(modeForJob(job));
  const finished = job.status === "completed" && verification.kind === "verified";
  const headline =
    job.status === "completed" && verification.kind !== "verified"
      ? verification.kind === "invalid"
        ? copy.unreadableTranscript
        : copy.checkingTranscript
      : statusLabel(job);

  return (
    <div className={styles.page}>
      <title>{`${job.episodeTitle} · Processing · Pebble`}</title>
      <BackToLibrary />
      <header className={styles.intro}>
        <p className={styles.eyebrow}>{copy.progressEyebrow}</p>
        <h1 className={styles.heading}>{job.episodeTitle}</h1>
      </header>

      <section className={styles.jobCard} aria-labelledby="job-status" data-status={job.status}>
        <p id="job-status" className={styles.jobHeadline} role="status" aria-live="polite">
          {headline}
        </p>
        {sectionProgress(job) ? <p className={styles.jobProgress}>{sectionProgress(job)}</p> : null}

        <ol className={styles.stages} aria-label="Stages">
          {steps.map((step, index) => (
            <li key={step.stage} data-state={stepState(job, index, finished)}>
              {step.label}
            </li>
          ))}
        </ol>

        {job.failure && job.status !== "completed" ? (
          <div className={styles.failure} role={job.status === "failed" ? "alert" : undefined}>
            <p>{job.failure.message}</p>
            {job.failure.hint ? <p className={styles.help}>{job.failure.hint}</p> : null}
            <p className={styles.code}>{job.failure.code}</p>
          </div>
        ) : null}
        {verification.kind === "invalid" ? (
          <p className={styles.formError} role="alert">
            {verification.message}
          </p>
        ) : null}
        {error && isActive(job) ? (
          <p className={styles.help}>Lost contact with the worker; still trying…</p>
        ) : null}
        {action.error ? (
          <p className={styles.formError} role="alert">
            {action.error}
          </p>
        ) : null}

        <div className={styles.actions}>
          {finished ? (
            <Link to={`/episodes/${job.episodeId}`} className={styles.primaryButton}>
              {copy.openAction}
            </Link>
          ) : null}
          {isActive(job) ? (
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={action.busy}
              onClick={() => void run(() => client.cancelJob(job.id))}
            >
              {job.status === "running" ? "Cancel processing" : "Cancel"}
            </button>
          ) : null}
          {canRetry(job) ? (
            <button
              type="button"
              className={styles.primaryButton}
              disabled={action.busy}
              onClick={() => void run(() => client.retryJob(job.id))}
            >
              Retry from the start
            </button>
          ) : null}
        </div>
        {job.status === "running" && action.busy ? (
          <p className={styles.help}>Stopping at the next safe point…</p>
        ) : null}
        <p className={styles.help}>Attempt {job.attempt}</p>
      </section>
    </div>
  );
}

function stepState(job: Job, index: number, finished: boolean): string {
  const current = job.stage
    ? stageSteps(modeForJob(job)).findIndex((s) => s.stage === job.stage)
    : -1;
  if (finished) return "done";
  if (job.status === "queued") return "pending";
  if (index < current) return "done";
  if (index === current) {
    if (job.status === "running") return "current";
    if (job.status === "completed") return "done";
    return job.status; // failed | cancelled
  }
  return "pending";
}

function BackToLibrary() {
  return (
    <Link to="/" className={styles.back}>
      ← Local library
    </Link>
  );
}
