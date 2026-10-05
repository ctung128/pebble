import { useState } from "react";
import { Link } from "react-router";
import type { Job } from "@pebble/schema";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { StatusView } from "../components/StatusView.tsx";
import { EpisodeRow, RowProgress, rowStyles } from "../features/library/EpisodeRow.tsx";
import {
  activityLabel,
  canRetry,
  failureCopy,
  isActive,
  requestProblem,
  statusLabel,
} from "./jobCopy.ts";
import { useJobAnnouncements } from "./useJobAnnouncements.ts";
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
  const announcement = useJobAnnouncements(jobs);

  return (
    <div className={styles.page}>
      <title>Local library · Pebble</title>
      <PageHeader
        title="Your local audio"
        vertical="书架"
        meta={ready && jobs && jobs.length > 0 ? librarySummary(jobs) : null}
      />

      {/* Only when something needs doing; a ready Pebble says nothing here. */}
      <WorkerStatusCard status={status} onRecheck={recheck} showReady={false} />

      {ready ? (
        error ? (
          <StatusView
            kind="error"
            title="Couldn't load your local audio"
            message="Check that Pebble is running, then try again."
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
          <ol className={rowStyles.list} aria-label="Local audio">
            {jobs.map((job, i) => (
              <JobRow key={job.id} job={job} number={i + 1} onChanged={refresh} />
            ))}
          </ol>
        )
      ) : null}

      {/* Announces a job starting, finishing or failing; never section-by-section progress. */}
      <p className={styles.visuallyHidden} role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

/** Real counts only, e.g. "4 episodes · 1 processing · 1 stopped". */
function librarySummary(jobs: readonly Job[]): string {
  const parts = [`${jobs.length} ${jobs.length === 1 ? "episode" : "episodes"}`];
  const active = jobs.filter(isActive).length;
  const stopped = jobs.filter((job) => job.status === "failed").length;
  if (active > 0) parts.push(`${active} processing`);
  if (stopped > 0) parts.push(`${stopped} stopped`);
  return parts.join(" · ");
}

const CREATED_DATE: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

function JobRow({ job, number, onChanged }: { job: Job; number: number; onChanged: () => void }) {
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
      setProblem(
        caught instanceof WorkerError
          ? requestProblem(caught.code, "That didn't work. Try again.")
          : "That didn't work. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const retryable = canRetry(job);
  // A finished row opens its transcript (or preview): the title is a link covering the row.
  const completed = job.status === "completed";
  return (
    <EpisodeRow
      number={number}
      title={job.episodeTitle}
      href={completed ? `/episodes/${job.episodeId}` : undefined}
      meta={
        <span className={rowStyles.metaItem}>
          {new Date(job.createdAt).toLocaleDateString(undefined, CREATED_DATE)}
        </span>
      }
      status={<JobStatus job={job} detailsLink={retryable} />}
      actions={
        <>
          {completed ? null : isActive(job) ? (
            <Link to={`/jobs/${job.id}`} className={rowStyles.action}>
              View progress
            </Link>
          ) : retryable ? (
            <button
              type="button"
              className={rowStyles.action}
              disabled={busy}
              onClick={() => void act(() => client.retryJob(job.id))}
            >
              Retry
            </button>
          ) : (
            <Link to={`/jobs/${job.id}`} className={rowStyles.action}>
              Details
            </Link>
          )}
          {!isActive(job) && LOCAL_EPISODE_ID.test(job.episodeId) ? (
            <ConfirmButton
              className={rowStyles.delete}
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
        </>
      }
      footer={
        problem ? (
          <p className={rowStyles.fieldError} role="alert">
            {problem}
          </p>
        ) : null
      }
    />
  );
}

/**
 * The worker's real state. The bar fills by completed sections once their total is known and
 * is indeterminate before that; the text never shows a percentage or a time estimate.
 */
function JobStatus({ job, detailsLink }: { job: Job; detailsLink: boolean }) {
  if (isActive(job)) {
    const fraction = job.progress ? job.progress.completedChunks / job.progress.totalChunks : null;
    return <RowProgress label={activityLabel(job)} fraction={fraction} />;
  }
  if (job.status === "failed") {
    return (
      <p className={rowStyles.failure}>
        <strong>{statusLabel(job)}.</strong> {failureCopy(job).reason}{" "}
        {detailsLink ? (
          // Retry is the row's action; what to do next is on the job page.
          <Link to={`/jobs/${job.id}`} className={styles.inlineLink}>
            Details
          </Link>
        ) : null}
      </p>
    );
  }
  if (job.status === "completed") {
    // Finished rows stay quiet; a preview keeps its label so it never passes for a transcript.
    return job.provider.kind === "mock" ? (
      <span className={rowStyles.warningTag}>Preview · placeholder text</span>
    ) : null;
  }
  return <RowProgress label={statusLabel(job)} />;
}
