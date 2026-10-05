import { createContext, useContext } from "react";

/** Mirrors the worker's rule (services/worker api.py `clean_title`), for early feedback. */
export const MAX_EPISODE_TITLE = 200;

/**
 * Why a new episode title can't be saved, or null. Trimmed, 1–200 characters (code points,
 * so any script counts the same), on one line. Punctuation is fine.
 */
export function episodeTitleProblem(title: string): string | null {
  const trimmed = title.trim();
  if (!trimmed) return "Give the episode a title.";
  if ([...trimmed].length > MAX_EPISODE_TITLE) {
    return `Keep the title to ${MAX_EPISODE_TITLE} characters or fewer.`;
  }
  if (/[\p{Cc}\u2028\u2029]/u.test(trimmed)) return "Keep the title on one line.";
  return null;
}

/**
 * Renaming, where the current source supports it (local mode with a 1.7 worker). The demo
 * never provides it, so the episode page shows no rename control there.
 */
export interface EpisodeRename {
  canRename(episodeId: string): boolean;
  /** Saves the title and resolves with the stored one; rejects with a learner-safe message. */
  rename(episodeId: string, title: string): Promise<string>;
}

export const EpisodeRenameContext = createContext<EpisodeRename | null>(null);

export function useEpisodeRename(): EpisodeRename | null {
  return useContext(EpisodeRenameContext);
}
