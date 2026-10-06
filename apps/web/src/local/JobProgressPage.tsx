import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { Job } from "@pebble/schema";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { StatusView } from "../components/StatusView.tsx";
import { useEpisodeRename } from "../features/episode/episodeRename.ts";
import { EpisodeTitle } from "../features/episode/EpisodeTitle.tsx";
import { useEpisodeSource } from "../data/SourceContext.tsx";
import {
  canRetry,
  failureCopy,
  isActive,
  requestProblem,
  stageSteps,
  statusLabel,
  type StageStep,
} from "./jobCopy.ts";
import { clock, contextLine, elapsedMs, estimateLeft, tabTitle } from "./jobProgress.ts";
import { LOCAL_COPY, modeForJob, type LocalMode } from "./providerCopy.ts";
import { useJobPolling } from "./useJobPolling.ts";
import { useNow, useProgressAnnouncement, useSectionChanges } from "./useJobProgress.ts";
import { WorkerError } from "./workerClient.ts";
import { useWorker } from "./WorkerContext.tsx";
import styles from "./local.module.css";

type Verification = { kind: "pending" } | { kind: "verified" } | { kind: "invalid" };

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
  const renamer = useEpisodeRename();
  const active = job !== null && isActive(job);
  const now = useNow(active);
  const sectionChanges = useSectionChanges(job);
  const announcement = useProgressAnnouncement(job, job ? headlineFor(job, verification) : "");
  // The reason a transcript couldn't be read stays out of the UI; the headline says what happened.

  // "Completed" is only shown once the transcript itself loads and validates.
  const completedEpisode = job?.status === "completed" ? job.episodeId : null;
  useEffect(() => {
    if (!completedEpisode) return;
    let cancelled = false;
    source.getTranscript(completedEpisode).then(
      () => !cancelled && setVerification({ kind: "verified" }),
      () => !cancelled && setVerification({ kind: "invalid" }),
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
        error:
          caught instanceof WorkerError
            ? requestProblem(caught.code, "That didn't work. Try again.")
            : "That didn't work. Try again.",
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
            title={error.code === "NOT_FOUND" ? "Not found" : "Can't reach Pebble"}
            message={
              error.code === "NOT_FOUND"
                ? "This audio isn't being processed."
                : "Check that Pebble is running, then try again."
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
  const headline = headlineFor(job, verification);
  const context = contextLine(job);
  const elapsed = elapsedMs(job, now);
  const estimate = estimateLeft(job, sectionChanges, now);

  return (
    <div className={styles.page}>
      <title>{tabTitle(job, finished)}</title>
      <BackToLibrary />
      <header className={styles.intro}>
        {/* "Creating your transcript…" only while that's true; the headline says when it's done. */}
        {isActive(job) ? <p className={styles.eyebrow}>{copy.progressEyebrow}</p> : null}
        {/* Rename once nothing is processing (finished, failed or cancelled). */}
        <EpisodeTitle
          title={job.episodeTitle}
          className={styles.heading}
          onRename={
            renamer && !isActive(job) && renamer.canRename(job.episodeId)
              ? async (next) => {
                  await renamer.rename(job.episodeId, next);
                  restart(); // the job (and its title) is read again
                }
              : undefined
          }
        />
        {context ? <p className={styles.jobContext}>{context}</p> : null}
      </header>

      <section className={styles.jobCard} aria-labelledby="job-status" data-status={job.status}>
        <p id="job-status" className={styles.jobHeadline}>
          {headline}
        </p>
        {/* Stage changes, and section progress at most every 30 s: not every poll. */}
        <p className={styles.visuallyHidden} role="status" aria-live="polite">
          {announcement}
        </p>
        <ProgressBar job={job} />
        {isActive(job) && (elapsed !== null || estimate) ? (
          <p className={styles.jobMeta}>
            {elapsed !== null ? (
              <span>{job.status === "queued" ? "Queued" : `Running for ${clock(elapsed)}`}</span>
            ) : null}
            {estimate ? (
              <span>
                {estimate} <span className={styles.estimateTag}>· estimate</span>
              </span>
            ) : null}
          </p>
        ) : null}
        {job.failure && job.status === "failed" ? (
          <div className={styles.failure} role="alert">
            <p>{failureCopy(job).reason}</p>
            <p className={styles.help}>{failureCopy(job).next}</p>
          </div>
        ) : null}
        {verification.kind === "invalid" ? (
          <p className={styles.formError} role="alert">
            Try processing this audio again.
          </p>
        ) : null}

        {/* The steps stay in view while there's something to watch; once done, the headline is enough. */}
        {job.status !== "completed" ? (
          <StageList job={job} steps={steps} finished={finished} mode={modeForJob(job)} />
        ) : null}

        {/* Leaving is safe: the work belongs to Pebble on this computer, not to this page. */}
        {isActive(job) ? (
          <p className={styles.help}>
            Processing continues while Pebble is running and your computer stays awake. You can
            leave this page.
          </p>
        ) : null}
        {error && isActive(job) ? (
          <p className={styles.help}>Lost contact with Pebble; still trying…</p>
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
            // Stopping throws away the work so far (a retry starts over), so it asks first.
            <ConfirmButton
              className={styles.secondaryButton}
              prompt="Stop processing? You can start it again later, from the beginning."
              confirmLabel="Stop processing"
              cancelLabel="Keep processing"
              disabled={action.busy}
              onConfirm={() => void run(() => client.cancelJob(job.id))}
            >
              Cancel processing
            </ConfirmButton>
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
      </section>
    </div>
  );
}

function headlineFor(job: Job, verification: Verification): string {
  const copy = LOCAL_COPY[modeForJob(job)];
  if (job.status === "completed" && verification.kind !== "verified") {
    return verification.kind === "invalid" ? copy.unreadableTranscript : copy.checkingTranscript;
  }
  return statusLabel(job);
}

/**
 * The bar fills only from real section counts. Before those exist it sweeps without a value
 * (indeterminate); a stopped job keeps how far it got.
 */
function ProgressBar({ job }: { job: Job }) {
  const progress = job.progress;
  if (job.status === "completed") {
    return (
      <div className={styles.bar} data-mode="done" aria-hidden="true">
        <span className={styles.barFill} style={{ width: "100%" }} />
      </div>
    );
  }
  if (job.status === "failed" || job.status === "cancelled") {
    if (!progress) return null;
    const width = `${(progress.completedChunks / progress.totalChunks) * 100}%`;
    return (
      <div className={styles.bar} data-mode="stopped" aria-hidden="true">
        <span className={styles.barFill} style={{ width }} />
      </div>
    );
  }
  if (job.status === "running" && job.stage === "transcribing" && progress) {
    const { completedChunks, totalChunks } = progress;
    return (
      <div
        className={styles.bar}
        data-mode="determinate"
        role="progressbar"
        aria-label="Sections processed"
        aria-valuemin={0}
        aria-valuemax={totalChunks}
        aria-valuenow={completedChunks}
        aria-valuetext={`${completedChunks} of ${totalChunks} sections`}
      >
        <span
          className={styles.barFill}
          style={{ width: `${(completedChunks / totalChunks) * 100}%` }}
        />
      </div>
    );
  }
  return (
    <div
      className={styles.bar}
      data-mode="indeterminate"
      role="progressbar"
      aria-label="Processing"
    >
      <span className={styles.barFill} />
    </div>
  );
}

function StageList({
  job,
  steps,
  finished,
  mode,
}: {
  job: Job;
  steps: StageStep[];
  finished: boolean;
  mode: LocalMode;
}) {
  return (
    <ol className={styles.stages} aria-label="Stages">
      {steps.map((step, index) => {
        const state = stepState(job, index, finished);
        const detail = state === "current" ? stepDetail(job, mode) : null;
        return (
          <li key={step.stage} data-state={state}>
            <span className={styles.stageMark} aria-hidden="true" />
            <span className={styles.stageLabel}>{step.label}</span>
            {detail ? <span className={styles.stageDetail}>{detail}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** The line under the current step: real section counts only. */
function stepDetail(job: Job, mode: LocalMode): string | null {
  if (job.status !== "running" || job.stage !== "transcribing" || !job.progress) return null;
  const { completedChunks, totalChunks } = job.progress;
  const current = Math.min(completedChunks + 1, totalChunks);
  const counts = `Section ${current} of ${totalChunks} · ${completedChunks} done`;
  // Speech models load on the first section, so it can run longer than the rest.
  return completedChunks === 0 && mode === "funasr"
    ? `${counts}. The first section can take longer.`
    : counts;
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
      ← Library
    </Link>
  );
}
