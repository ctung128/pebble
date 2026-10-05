import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { Job } from "@pebble/schema";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { SearchField } from "../components/SearchField.tsx";
import { formatDuration, formatTime } from "../lib/formatTime.ts";
import { matchesQuery } from "../lib/search.ts";
import { useDebouncedAnnouncement } from "../lib/useDebouncedAnnouncement.ts";
import { listeningState } from "../features/learning/playback.ts";
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
import {
  emptyMessage,
  LibraryFilters,
  listeningFilterOf,
  type LibraryFilter,
} from "./LibraryFilters.tsx";
import styles from "./local.module.css";

export const DELETE_PROMPT =
  "Delete this audio from Pebble? This removes the audio, its transcript, your edits to it and its processing files from this computer. Learning items you saved from it stay in Learning items, marked “Source deleted.” This can't be undone.";

export function LocalLibraryPage() {
  const { client, status, recheck } = useWorker();
  const ready = status.kind === "ready";
  const { jobs, error, refresh } = useJobList(client, ready);
  const announcement = useJobAnnouncements(jobs);
  const { playbackFor, persistence } = useLearning();
  const [query, setQuery] = useState("");
  const [chosenFilter, setFilter] = useState<LibraryFilter>("all");
  // Listening filters wait for browser storage; until then only All is honest.
  const listeningReady = persistence.mode !== "loading";
  const filter = listeningReady ? chosenFilter : "all";
  // Titles only: never file names, paths, transcripts, notes or anything else.
  const searched = useMemo(
    () => (jobs ?? []).filter((job) => matchesQuery(job.episodeTitle, query)),
    [jobs, query],
  );
  const stateOf = (job: Job) => listeningFilterOf(job, playbackFor(job.episodeId));
  const counts: Record<LibraryFilter, number> = {
    all: searched.length,
    "not-started": searched.filter((job) => stateOf(job) === "not-started").length,
    "in-progress": searched.filter((job) => stateOf(job) === "in-progress").length,
    finished: searched.filter((job) => stateOf(job) === "finished").length,
  };
  const shown = filter === "all" ? searched : searched.filter((job) => stateOf(job) === filter);
  const searching = query.trim() !== "";
  const resultCount = useDebouncedAnnouncement(
    (searching || filter !== "all") && jobs ? `${shown.length} of ${jobs.length} episodes` : "",
  );

  return (
    <div className={styles.page}>
      <title>Library · Pebble</title>
      <PageHeader
        title="Library"
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
          <>
            <SearchField
              label="Search episodes"
              placeholder="Search titles"
              value={query}
              onChange={setQuery}
            />
            <LibraryFilters
              value={filter}
              onChange={setFilter}
              counts={counts}
              listeningReady={listeningReady}
            />
            {shown.length === 0 ? (
              <div className={styles.noResults}>
                <p className={styles.noResultsTitle}>
                  {searching ? `No episodes match “${query.trim()}”.` : emptyMessage(filter)}
                </p>
                <div className={styles.actions}>
                  {searching ? (
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => setQuery("")}
                    >
                      Clear search
                    </button>
                  ) : null}
                  {filter !== "all" ? (
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => setFilter("all")}
                    >
                      Show all
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <ol className={rowStyles.list} aria-label="Local audio">
                {shown.map((job, i) => (
                  <JobRow key={job.id} job={job} number={i + 1} onChanged={refresh} />
                ))}
              </ol>
            )}
            <p className={styles.visuallyHidden} role="status" aria-live="polite">
              {resultCount}
            </p>
          </>
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

/**
 * "Oct 5, 2026 · 12:48 · 214 lines": the date always, then, for a finished episode, its length
 * and line count when the worker reports them (1.7; an older worker sends neither). A preview's
 * lines are placeholder text, so it never shows a line count.
 */
function JobMeta({ job }: { job: Job }) {
  const finished = job.status === "completed";
  const duration = finished ? formatDuration(job.durationMs) : null;
  const lines =
    finished && job.provider.kind !== "mock" && job.lineCount !== undefined && job.lineCount > 0
      ? `${job.lineCount} ${job.lineCount === 1 ? "line" : "lines"}`
      : null;
  const parts = [
    new Date(job.createdAt).toLocaleDateString(undefined, CREATED_DATE),
    duration,
    lines,
  ];
  // One run of text: each part stays whole; lines break only between parts.
  return (
    <span>
      {parts
        .filter((part): part is string => part !== null)
        .map((part, i) => (
          <span key={part}>
            {i > 0 ? " · " : ""}
            <span className={rowStyles.metaItem}>{part}</span>
          </span>
        ))}
    </span>
  );
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
      meta={<JobMeta job={job} />}
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
    // Waiting behind another episode: no activity to show, so no bar.
    const fraction =
      job.status === "queued"
        ? undefined
        : job.progress
          ? job.progress.completedChunks / job.progress.totalChunks
          : null;
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
    // A preview's placeholder status is shown on its episode page (the preview banner).
    return <ListeningStatus job={job} />;
  }
  return <RowProgress label={statusLabel(job)} />;
}

/**
 * How far the learner has listened, from browser-local playback (finished episodes only):
 * "12:48 of 1:22:15" with a bar while in progress, a quiet "Finished" after a real end, and
 * nothing before they start (or when the worker doesn't report the episode's length).
 */
function ListeningStatus({ job }: { job: Job }) {
  const { playbackFor } = useLearning();
  const record = playbackFor(job.episodeId);
  const state = listeningState(record, job.durationMs);
  if (!record || state === "not-started" || !job.durationMs) return null;
  if (state === "finished") return <span className={rowStyles.quietStatus}>Finished</span>;
  return (
    <RowProgress
      label={`${formatTime(record.positionMs)} of ${formatTime(job.durationMs)}`}
      fraction={Math.min(record.positionMs / job.durationMs, 1)}
      tone="listening"
    />
  );
}
