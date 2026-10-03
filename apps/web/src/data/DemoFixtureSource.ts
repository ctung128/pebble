import {
  parseIllustrativeUncertainty,
  parseManifest,
  parseTranscript,
  type Episode,
  type Manifest,
  type ParseResult,
  type Transcript,
} from "@pebble/schema";
import {
  SourceError,
  type EpisodeSource,
  type ResolvedEpisode,
  type ReviewHint,
} from "./EpisodeSource.ts";

type FetchLike = (input: string) => Promise<Response>;

/**
 * Reads the bundled static fixtures (manifest.json + per-episode transcript/audio).
 * Needs no worker, keys or network beyond the page's own origin.
 */
export class DemoFixtureSource implements EpisodeSource {
  readonly mode = "demo" as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private manifest: Promise<Manifest> | null = null;

  /** @param baseUrl absolute URL of the fixture directory, ending in "/" */
  constructor(baseUrl: string, fetchImpl: FetchLike = (input) => fetch(input)) {
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  async listEpisodes(): Promise<Episode[]> {
    return (await this.loadManifest()).episodes;
  }

  async getEpisode(id: string): Promise<ResolvedEpisode> {
    const episode = (await this.loadManifest()).episodes.find((e) => e.id === id);
    if (!episode) throw new SourceError("NOT_FOUND", `No episode with id "${id}".`);
    return { ...episode, audioUrl: this.resolve(episode.audio.src) };
  }

  async getTranscript(episodeId: string): Promise<Transcript> {
    const episode = await this.getEpisode(episodeId);
    const transcript = unwrap(parseTranscript(await this.fetchJson(episode.transcript.src)));
    if (transcript.episodeId !== episodeId) {
      throw new SourceError(
        "INVALID_PAYLOAD",
        `Transcript belongs to "${transcript.episodeId}", expected "${episodeId}".`,
      );
    }
    return transcript;
  }

  async getReviewHints(episodeId: string): Promise<ReviewHint[]> {
    const path = (await this.getEpisode(episodeId)).demo?.illustrativeUncertainty;
    if (!path) return [];
    const flags = unwrap(parseIllustrativeUncertainty(await this.fetchJson(path)));
    if (flags.episodeId !== episodeId) {
      throw new SourceError("INVALID_PAYLOAD", `Review hints belong to "${flags.episodeId}".`);
    }
    return flags.segments.map(({ segmentId }) => ({ segmentId, source: "illustrative" }));
  }

  /** Absolute URL of the episode's prepared demo translations, or null if it has none. */
  async getDemoTranslationsUrl(episodeId: string): Promise<string | null> {
    const path = (await this.getEpisode(episodeId)).demo?.translations;
    return path ? this.resolve(path) : null;
  }

  private loadManifest(): Promise<Manifest> {
    this.manifest ??= this.fetchJson("manifest.json")
      .then((json) => unwrap(parseManifest(json)))
      .catch((error: unknown) => {
        this.manifest = null; // allow a retry after failure
        throw error;
      });
    return this.manifest;
  }

  private resolve(path: string): string {
    return new URL(path, this.baseUrl).href;
  }

  private async fetchJson(path: string): Promise<unknown> {
    const url = this.resolve(path);
    let response: Response;
    try {
      response = await this.fetchImpl(url);
    } catch (cause) {
      throw new SourceError("NETWORK", `Request for ${path} failed.`, { cause });
    }
    if (response.status === 404) throw new SourceError("NOT_FOUND", `${path} was not found.`);
    if (!response.ok) throw new SourceError("NETWORK", `${path} returned HTTP ${response.status}.`);
    try {
      return await response.json();
    } catch (cause) {
      throw new SourceError("INVALID_PAYLOAD", `${path} is not valid JSON.`, { cause });
    }
  }
}

function unwrap<T>(result: ParseResult<T>): T {
  if (result.ok) return result.data;
  throw new SourceError(result.code, result.message, { details: result.issues });
}

export function createDefaultSource(): DemoFixtureSource {
  return new DemoFixtureSource(new URL(`${import.meta.env.BASE_URL}demo/`, document.baseURI).href);
}
