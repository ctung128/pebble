import type { Episode, Transcript } from "@pebble/schema";

/** "local" (the 127.0.0.1 worker) arrives in M0C. */
export type SourceMode = "demo";

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

export function describeSourceError(error: unknown): { title: string; detail: string } {
  if (!(error instanceof SourceError)) {
    return { title: "Something went wrong", detail: "An unexpected error occurred." };
  }
  switch (error.code) {
    case "NOT_FOUND":
      return { title: "Not found", detail: error.message };
    case "NETWORK":
      return { title: "Couldn't load content", detail: error.message };
    case "INVALID_PAYLOAD":
      return { title: "Content is malformed", detail: error.message };
    case "UNSUPPORTED_VERSION":
      return { title: "Unsupported content version", detail: error.message };
  }
}
