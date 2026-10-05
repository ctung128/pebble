import type { Episode, Transcript } from "@pebble/schema";

/** "demo": bundled fixtures. "local": the 127.0.0.1 worker (local-mode build only). */
export type SourceMode = "demo" | "local";

export interface ResolvedEpisode extends Episode {
  /** Absolute URL the <audio> element can load. */
  audioUrl: string;
}

/**
 * A segment flagged for learner review. `source` keeps simulated flags distinguishable from
 * real provider signals in the data, even though the learner-facing copy is the same.
 */
export interface ReviewHint {
  segmentId: string;
  source: "illustrative" | "provider";
}

/** Everything the UI needs from a content backend. Implementations validate payloads. */
export interface EpisodeSource {
  readonly mode: SourceMode;
  listEpisodes(): Promise<Episode[]>;
  getEpisode(id: string): Promise<ResolvedEpisode>;
  getTranscript(episodeId: string): Promise<Transcript>;
  /** Review hints that do not come from the transcript itself (e.g. demo fixtures). */
  getReviewHints(episodeId: string): Promise<ReviewHint[]>;
}

export type SourceErrorCode = "NOT_FOUND" | "NETWORK" | "INVALID_PAYLOAD" | "UNSUPPORTED_VERSION";

export class SourceError extends Error {
  readonly code: SourceErrorCode;
  readonly details: unknown;

  constructor(
    code: SourceErrorCode,
    message: string,
    options?: { details?: unknown; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "SourceError";
    this.code = code;
    this.details = options?.details;
  }
}

/**
 * Learner-facing words for a content error. The error's own message stays out of the UI: it
 * can name files, HTTP details or (in local mode) the worker.
 */
export function describeSourceError(error: unknown): { title: string; detail: string } {
  if (!(error instanceof SourceError)) {
    return { title: "Something went wrong", detail: "Try again." };
  }
  switch (error.code) {
    case "NOT_FOUND":
      return { title: "Not found", detail: "This episode isn't in your library." };
    case "NETWORK":
      return { title: "Couldn't load content", detail: "Pebble couldn't load this. Try again." };
    case "INVALID_PAYLOAD":
      return { title: "Content is malformed", detail: "This content couldn't be read." };
    case "UNSUPPORTED_VERSION":
      return {
        title: "Unsupported content version",
        detail: "This content needs a different version of Pebble.",
      };
  }
}
