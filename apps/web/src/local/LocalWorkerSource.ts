import {
  EpisodeSchema,
  parseManifest,
  parseTranscript,
  type Episode,
  type Transcript,
} from "@pebble/schema";
import {
  SourceError,
  type EpisodeSource,
  type ResolvedEpisode,
  type ReviewHint,
} from "../data/EpisodeSource.ts";
import { LOCAL_EPISODE_ID } from "./workerClient.ts";

type FetchLike = (input: string) => Promise<Response>;

/** Reads processed episodes from the local worker; validates every payload. */
export class LocalWorkerSource implements EpisodeSource {
  readonly mode = "local" as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(baseUrl: string, fetchImpl: FetchLike = (input) => fetch(input)) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    this.fetchImpl = fetchImpl;
  }

  async listEpisodes(): Promise<Episode[]> {
    const result = parseManifest(await this.fetchJson("episodes"));
    if (!result.ok) throw new SourceError(result.code, result.message, { details: result.issues });
    return result.data.episodes;
  }

  async getEpisode(id: string): Promise<ResolvedEpisode> {
    if (!LOCAL_EPISODE_ID.test(id)) throw new SourceError("NOT_FOUND", `No local episode "${id}".`);
    const parsed = EpisodeSchema.safeParse(await this.fetchJson(`episodes/${id}`));
    if (!parsed.success) {
      throw new SourceError("INVALID_PAYLOAD", "The worker returned an invalid episode.", {
        details: parsed.error.issues,
      });
    }
    // Audio streams from the worker's range-supporting endpoint.
    return { ...parsed.data, audioUrl: new URL(parsed.data.audio.src, this.baseUrl).href };
  }

  async getTranscript(episodeId: string): Promise<Transcript> {
    if (!LOCAL_EPISODE_ID.test(episodeId)) {
      throw new SourceError("NOT_FOUND", `No local episode "${episodeId}".`);
    }
    const result = parseTranscript(await this.fetchJson(`episodes/${episodeId}/transcript`));
    if (!result.ok) throw new SourceError(result.code, result.message, { details: result.issues });
    if (result.data.episodeId !== episodeId) {
      throw new SourceError("INVALID_PAYLOAD", "The worker returned another episode's transcript.");
    }
    return result.data;
  }

  /** Local transcripts carry their own signals (provider confidence); no extra hints. */
  async getReviewHints(): Promise<ReviewHint[]> {
    return [];
  }

  private async fetchJson(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl).href);
    } catch (cause) {
      throw new SourceError(
        "NETWORK",
        "Pebble's local worker is not running. Start it with npm run worker.",
        { cause },
      );
    }
    if (response.status === 404)
      throw new SourceError("NOT_FOUND", "This local episode wasn't found.");
    if (response.status === 409) {
      throw new SourceError("NOT_FOUND", "This local episode hasn't finished processing.");
    }
    if (!response.ok)
      throw new SourceError("NETWORK", `The worker returned HTTP ${response.status}.`);
    try {
      return await response.json();
    } catch (cause) {
      throw new SourceError("INVALID_PAYLOAD", "The worker's reply wasn't valid JSON.", { cause });
    }
  }
}
