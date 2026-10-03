import { parseDemoTranslations } from "@pebble/schema";
import {
  TranslationError,
  type Translation,
  type TranslationProvider,
  type TranslationRequest,
} from "./TranslationProvider.ts";

type FetchLike = (input: string) => Promise<Response>;

interface DemoTranslationOptions {
  /** Resolves the episode's prepared translations file, or null if it has none. */
  locate: (episodeId: string) => Promise<string | null>;
  fetchImpl?: FetchLike;
  /** Simulated latency so loading states are exercised like a real provider. */
  delayMs?: number;
  /** Development switch: fail every request with a retryable error. */
  alwaysFail?: boolean;
}

/**
 * Serves prepared sample translations bundled with the demo. Translations are tied to the
 * transcript's original text, so an edited line has none.
 */
export class DemoTranslationProvider implements TranslationProvider {
  readonly id = "demo-prepared";
  private readonly options: Required<Omit<DemoTranslationOptions, "fetchImpl">> & {
    fetchImpl: FetchLike;
  };
  private readonly tables = new Map<string, Promise<Record<string, string>>>();

  constructor(options: DemoTranslationOptions) {
    this.options = {
      fetchImpl: (input) => fetch(input),
      delayMs: 600,
      alwaysFail: false,
      ...options,
    };
  }

  async translate(request: TranslationRequest): Promise<Translation> {
    await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    if (this.options.alwaysFail) throw unavailable();
    if (request.text !== request.sourceText) {
      throw new TranslationError(
        "NOT_FOR_EDITED_TEXT",
        "No translation is available for your edited version of this line.",
      );
    }
    const table = await this.load(request.episodeId);
    const text = table[request.segmentId];
    if (!text) throw unavailable();
    return { text, language: "en" };
  }

  private load(episodeId: string): Promise<Record<string, string>> {
    let table = this.tables.get(episodeId);
    if (!table) {
      table = this.fetchTable(episodeId).catch((cause: unknown) => {
        this.tables.delete(episodeId); // allow a retry
        throw unavailable(cause);
      });
      this.tables.set(episodeId, table);
    }
    return table;
  }

  private async fetchTable(episodeId: string): Promise<Record<string, string>> {
    const url = await this.options.locate(episodeId);
    if (!url) return {};
    const response = await this.options.fetchImpl(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = parseDemoTranslations(await response.json());
    if (!parsed.ok) throw new Error(parsed.message);
    if (parsed.data.episodeId !== episodeId)
      throw new Error("Translations belong to another episode");
    return parsed.data.translations;
  }
}

function unavailable(cause?: unknown) {
  return new TranslationError(
    "UNAVAILABLE",
    "Translation is unavailable right now. Try again, or keep listening.",
    { cause },
  );
}
