import type { Job } from "@pebble/schema";
import { listeningState, type PlaybackRecord } from "../features/learning/playback.ts";
import styles from "./LibraryFilters.module.css";

export type LibraryFilter = "all" | "not-started" | "in-progress" | "finished";

const FILTERS: { id: LibraryFilter; label: string; empty: string }[] = [
  { id: "all", label: "All", empty: "No episodes yet." },
  { id: "not-started", label: "Not started", empty: "Every episode has been started." },
  { id: "in-progress", label: "In progress", empty: "No episodes in progress." },
  { id: "finished", label: "Finished", empty: "No finished episodes yet." },
];

/**
 * Where an episode stands for the listening filters, or null when it belongs under All only:
 * anything not finished processing (queued, running, failed, cancelled), and episodes whose
 * length the worker doesn't report (their progress can't be checked).
 */
export function listeningFilterOf(
  job: Job,
  record: PlaybackRecord | null,
): Exclude<LibraryFilter, "all"> | null {
  if (job.status !== "completed" || !job.durationMs) return null;
  return listeningState(record, job.durationMs);
}

export function emptyMessage(filter: LibraryFilter): string {
  return FILTERS.find((f) => f.id === filter)!.empty;
}

interface LibraryFiltersProps {
  value: LibraryFilter;
  onChange: (filter: LibraryFilter) => void;
  /** How many of the (searched) episodes each filter would show. */
  counts: Record<LibraryFilter, number>;
  /** While browser storage is still loading, listening filters would mislead: off. */
  listeningReady: boolean;
}

/**
 * The Library's filters, as a labelled group of toggle buttons (they filter one list; they
 * don't switch panels, so not tabs). A filter with nothing in it is hidden, except All and the
 * one currently chosen.
 */
export function LibraryFilters({ value, onChange, counts, listeningReady }: LibraryFiltersProps) {
  return (
    <div className={styles.filters} role="group" aria-label="Filter episodes">
      {FILTERS.filter((f) => f.id === "all" || f.id === value || counts[f.id] > 0).map((f) => (
        <button
          key={f.id}
          type="button"
          className={styles.filter}
          aria-pressed={value === f.id}
          disabled={f.id !== "all" && !listeningReady}
          onClick={() => onChange(f.id)}
        >
          {f.label}
          <span className={styles.count}>{counts[f.id]}</span>
        </button>
      ))}
    </div>
  );
}
