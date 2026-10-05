import { useMemo, type ReactNode } from "react";
import { EpisodeRenameContext, type EpisodeRename } from "../features/episode/episodeRename.ts";
import { requestProblem } from "./jobCopy.ts";
import { LOCAL_EPISODE_ID, WorkerError } from "./workerClient.ts";
import { useWorker } from "./WorkerContext.tsx";

/** Rename arrived in contract 1.7; an older worker gets no rename control at all. */
export const RENAME_SCHEMA_MINOR = 7;

/** Plain words for a failed rename. The worker's own message never reaches the page. */
export function renameProblem(error: unknown): string {
  if (!(error instanceof WorkerError)) return "Couldn't rename. Try again.";
  switch (error.code) {
    case "INVALID_TITLE":
      return "Give the episode a title of 1–200 characters, on one line.";
    case "NOT_FOUND":
      return "This episode isn't in your library anymore.";
    default:
      return requestProblem(error.code, "Couldn't rename. Try again.");
  }
}

/** Offers renaming of local episodes to the pages below, when the worker supports it. */
export function LocalRenameProvider({ children }: { children: ReactNode }) {
  const { client, status } = useWorker();
  const minor =
    status.kind === "ready" ? Number(status.health.schemaVersion.split(".")[1] ?? 0) : 0;
  const value = useMemo<EpisodeRename | null>(
    () =>
      minor >= RENAME_SCHEMA_MINOR
        ? {
            canRename: (episodeId) => LOCAL_EPISODE_ID.test(episodeId),
            rename: async (episodeId, title) => {
              try {
                return (await client.renameEpisode(episodeId, title)).episodeTitle;
              } catch (error) {
                throw new Error(renameProblem(error), { cause: error });
              }
            },
          }
        : null,
    [client, minor],
  );
  return <EpisodeRenameContext.Provider value={value}>{children}</EpisodeRenameContext.Provider>;
}
