export interface TranslationRequest {
  episodeId: string;
  segmentId: string;
  /** The text to translate — the learner's correction if the line was edited. */
  text: string;
  /** The transcript's original text for the segment. */
  sourceText: string;
}

export interface Translation {
  text: string;
  language: string;
}

export type TranslationErrorCode = "UNAVAILABLE" | "NOT_FOR_EDITED_TEXT";

export class TranslationError extends Error {
  readonly code: TranslationErrorCode;
  readonly retryable: boolean;

  constructor(code: TranslationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "TranslationError";
    this.code = code;
    this.retryable = code === "UNAVAILABLE";
  }
}

/** Line-level, on-demand translation. Implementations must never be called eagerly. */
export interface TranslationProvider {
  readonly id: string;
  translate(request: TranslationRequest): Promise<Translation>;
}

const cacheKey = ({ episodeId, segmentId, text }: TranslationRequest) =>
  `${episodeId}\u0000${segmentId}\u0000${text}`;

/** Remembers successful translations for the browser session (not persisted). */
export class SessionCachedTranslationProvider implements TranslationProvider {
  readonly id: string;
  private readonly inner: TranslationProvider;
  private readonly pending = new Map<string, Promise<Translation>>();
  private readonly resolved = new Map<string, Translation>();

  constructor(inner: TranslationProvider) {
    this.inner = inner;
    this.id = inner.id;
  }

  translate(request: TranslationRequest): Promise<Translation> {
    const key = cacheKey(request);
    const done = this.resolved.get(key);
    if (done) return Promise.resolve(done);
    let promise = this.pending.get(key);
    if (!promise) {
      promise = this.inner.translate(request).then(
        (translation) => {
          this.resolved.set(key, translation);
          this.pending.delete(key);
          return translation;
        },
        (error: unknown) => {
          this.pending.delete(key);
          throw error;
        },
      );
      this.pending.set(key, promise);
    }
    return promise;
  }

  /** A translation already resolved this session, without requesting one. */
  peek(request: TranslationRequest): Translation | undefined {
    return this.resolved.get(cacheKey(request));
  }
}
