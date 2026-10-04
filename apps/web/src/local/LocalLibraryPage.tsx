import { useState } from "react";
import { Link } from "react-router";
import type { Job } from "@pebble/schema";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { StatusView } from "../components/StatusView.tsx";
import { canRetry, isActive, sectionProgress, statusLabel } from "./jobCopy.ts";
import { LOCAL_COPY, modeForJob } from "./providerCopy.ts";
import { useJobList } from "./useJobList.ts";
import { LOCAL_EPISODE_ID, WorkerError } from "./workerClient.ts";
import { useLearning } from "../features/learning/LearningContext.tsx";
import { useWorker } from "./WorkerContext.tsx";
import { WorkerStatusCard } from "./WorkerStatusCard.tsx";
import styles from "./local.module.css";

export const DELETE_PROMPT =
  "Delete this audio from Pebble? This removes the audio, its transcript, your edits to it and its processing files from this computer. Learning items you saved from it stay in Learning items, marked “Source deleted.” This can't be undone.";

export function LocalLibraryPage() {
  const { client, status, recheck } = useWorker();
  const ready = status.kind === "ready";
  const { jobs, error, refresh } = useJobList(client, ready);

  return (
    <div className={styles.page}>
      <title>Local library · Pebble</title>
      <header className={styles.intro}>
        <h1 className={styles.heading}>Your local audio</h1>
        <p className={styles.lede}>
          Audio you processed with Pebble's worker on this computer. It never leaves this machine.
        </p>
      </header>

      <WorkerStatusCard status={status} onRecheck={recheck} />

      {ready ? (
        <>
          <p>
            <Link to="/process" className={styles.primaryButton}>
              {LOCAL_COPY[status.mode].uploadHeading}
            </Link>
          </p>
          {error ? (
            <StatusView
              kind="error"
              title="Couldn't load your local audio"
              message={error.message}
              onRetry={refresh}
            />
          ) : jobs === null ? (
            <StatusView kind="loading" title="Loading your local audio…" />
          ) : jobs.length === 0 ? (
            <StatusView
              kind="empty"
              title="No local audio yet"
              message="Process an audio file you own and it will appear here."
            />
          ) : (
            <ul className={styles.jobList} aria-label="Local audio">
              {jobs.map((job) => (
                <JobRow key={job.id} job={job} onChanged={refresh} />
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}

function JobRow({ job, onChanged }: { job: Job; onChanged: () => void }) {
  const { client } = useWorker();
  const { markSourceDeleted } = useLearning();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await operation();
      onChanged();
    } catch (caught) {
      setProblem(caught instanceof WorkerError ? caught.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  const progress = sectionProgress(job);
  return (
    <li className={styles.jobRow} data-status={job.status}>
      <div className={styles.jobMain}>
        <p className={styles.jobTitle}>{job.episodeTitle}</p>
        <p className={styles.jobMeta}>
          <span className={styles.badge} data-status={job.status}>
            {statusLabel(job)}
          </span>
          {progress && isActive(job) ? <span>{progress}</span> : null}
          {job.provider.kind === "mock" ? (
            <span className={styles.previewTag}>Preview · placeholder text</span>
          ) : null}
          <span>{new Date(job.createdAt).toLocaleString()}</span>
        </p>
        {job.failure && job.status === "failed" ? (
          <p className={styles.help}>{job.failure.message}</p>
        ) : null}
        {problem ? (
          <p className={styles.fieldError} role="alert">
            {problem}
          </p>
        ) : null}
      </div>
      <div className={styles.rowActions}>
        {job.status === "completed" ? (
          <Link to={`/episodes/${job.episodeId}`} className={styles.secondaryButton}>
            {LOCAL_COPY[modeForJob(job)].libraryOpenAction}
          </Link>
        ) : (
          <Link to={`/jobs/${job.id}`} className={styles.secondaryButton}>
            {isActive(job) ? "View progress" : "Details"}
          </Link>
        )}
        {canRetry(job) ? (
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={busy}
            onClick={() => void act(() => client.retryJob(job.id))}
          >
            Retry
          </button>
        ) : null}
        {!isActive(job) && LOCAL_EPISODE_ID.test(job.episodeId) ? (
          <ConfirmButton
            className={styles.dangerLink}
            prompt={DELETE_PROMPT}
            confirmLabel="Delete"
            aria-label={`Delete ${job.episodeTitle}`}
            onConfirm={() =>
              void act(async () => {
                // Browser data changes only after the worker has deleted the episode.
                await client.deleteEpisode(job.episodeId);
                markSourceDeleted(job.episodeId);
              })
            }
          >
            Delete
          </ConfirmButton>
        ) : null}
      </div>
    </li>
  );
}
