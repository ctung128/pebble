import {
  CURRENT_SCHEMA_VERSION,
  TRANSLATION_PROVIDER,
  parseEpisodeTranslations,
  parseJob,
  parseTranslationConsent,
  parseTranslationResult,
  parseWorkerHealth,
  type EpisodeTranslations,
  type Job,
  type ParseResult,
  type TranslationConsent,
  type TranslationResult,
  type WorkerHealth,
} from "@pebble/schema";

/** Worker-reported codes (e.g. FILE_TOO_LARGE) plus client-side ones. */
export type WorkerErrorCode = "UNREACHABLE" | "INVALID_RESPONSE" | "ABORTED" | (string & {});

export class WorkerError extends Error {
  readonly code: WorkerErrorCode;
  readonly status: number | null;
  readonly hint: string | null;

  constructor(
    code: WorkerErrorCode,
    message: string,
    options: { status?: number; hint?: string | null; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "WorkerError";
    this.code = code;
    this.status = options.status ?? null;
    this.hint = options.hint ?? null;
  }
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

export interface UploadRequest {
  file: File;
  title: string;
  /** Must be true: the learner confirmed they own or may process this audio. */
  ownershipConfirmed: true;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

/** Everything local mode asks of the 127.0.0.1 worker. */
export interface WorkerClient {
  readonly baseUrl: string;
  /** Rejects with UNREACHABLE when no worker answers; otherwise returns the parse result. */
  health(): Promise<ParseResult<WorkerHealth>>;
  listJobs(): Promise<Job[]>;
  getJob(id: string): Promise<Job>;
  cancelJob(id: string): Promise<Job>;
  retryJob(id: string): Promise<Job>;
  deleteEpisode(episodeId: string): Promise<void>;
  /** 1.7: changes only the episode's user-facing title; resolves with its job. */
  renameEpisode(episodeId: string, title: string): Promise<Job>;
  upload(request: UploadRequest): Promise<Job>;
  /** 1.8: the episode's cached English. Local and read-only: never contacts DeepL. */
  getEpisodeTranslations(episodeId: string): Promise<EpisodeTranslations>;
  /** 1.8: one displayed line, sent only on an explicit request. */
  translateLine(request: TranslationLineRequest): Promise<TranslationResult>;
  /** 1.8: accepts the given consent version for every browser using this worker. */
  grantTranslationConsent(consentVersion: string): Promise<TranslationConsent>;
  /** 1.8: withdraws consent for every browser using this worker (idempotent). */
  withdrawTranslationConsent(): Promise<TranslationConsent>;
}

export interface TranslationLineRequest {
  episodeId: string;
  segmentId: string;
  /** Exactly the text to translate (NFC, as checked by the shared text rules). */
  text: string;
}

/** Worker episode ids; anything else is never sent to the delete endpoint. */
export const LOCAL_EPISODE_ID = /^ep-[0-9a-f]{12}$/;
const JOB_ID = /^job-[0-9a-f]{12}$/;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class HttpWorkerClient implements WorkerClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly createXhr: () => XMLHttpRequest;

  constructor(
    baseUrl: string,
    options: { fetchImpl?: FetchLike; createXhr?: () => XMLHttpRequest } = {},
  ) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.createXhr = options.createXhr ?? (() => new XMLHttpRequest());
  }

  async health(): Promise<ParseResult<WorkerHealth>> {
    return parseWorkerHealth(await this.request("health"));
  }

  async listJobs(): Promise<Job[]> {
    const body = (await this.request("jobs")) as { jobs?: unknown };
    if (!Array.isArray(body?.jobs)) throw invalid("The job list was malformed.");
    return body.jobs.map(validJob);
  }

  async getJob(id: string): Promise<Job> {
    return validJob(await this.request(`jobs/${checkedJobId(id)}`));
  }

  async cancelJob(id: string): Promise<Job> {
    return validJob(await this.request(`jobs/${checkedJobId(id)}/cancel`, { method: "POST" }));
  }

  async retryJob(id: string): Promise<Job> {
    return validJob(await this.request(`jobs/${checkedJobId(id)}/retry`, { method: "POST" }));
  }

  async deleteEpisode(episodeId: string): Promise<void> {
    if (!LOCAL_EPISODE_ID.test(episodeId)) {
      throw new WorkerError("INVALID_EPISODE", "Only local episodes can be deleted.");
    }
    await this.request(`episodes/${episodeId}`, { method: "DELETE" });
  }

  async renameEpisode(episodeId: string, title: string): Promise<Job> {
    if (!LOCAL_EPISODE_ID.test(episodeId)) {
      throw new WorkerError("NOT_FOUND", "No such episode.", { status: 404 });
    }
    return validJob(
      await this.request(`episodes/${episodeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      }),
    );
  }

  async getEpisodeTranslations(episodeId: string): Promise<EpisodeTranslations> {
    if (!LOCAL_EPISODE_ID.test(episodeId)) {
      throw new WorkerError("EPISODE_NOT_FOUND", "No such episode.", { status: 404 });
    }
    const result = parseEpisodeTranslations(
      await this.request(`episodes/${episodeId}/translations`),
    );
    if (!result.ok) throw invalid(result.message);
    if (result.data.episodeId !== episodeId)
      throw invalid("The cached English is for another episode.");
    return result.data;
  }

  async translateLine({
    episodeId,
    segmentId,
    text,
  }: TranslationLineRequest): Promise<TranslationResult> {
    if (!LOCAL_EPISODE_ID.test(episodeId)) {
      throw new WorkerError("EPISODE_NOT_FOUND", "No such episode.", { status: 404 });
    }
    // Exactly the approved request: no other fields or metadata.
    const body = { schemaVersion: CURRENT_SCHEMA_VERSION, episodeId, segmentId, text };
    const result = parseTranslationResult(
      await this.request("translations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    if (!result.ok) throw invalid(result.message);
    if (result.data.episodeId !== episodeId || result.data.segmentId !== segmentId) {
      throw invalid("The translation is for another line.");
    }
    return result.data;
  }

  async grantTranslationConsent(consentVersion: string): Promise<TranslationConsent> {
    const body = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      provider: TRANSLATION_PROVIDER,
      consentVersion,
    };
    const result = parseTranslationConsent(
      await this.request("translation/consent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    if (!result.ok) throw invalid(result.message);
    return result.data;
  }

  async withdrawTranslationConsent(): Promise<TranslationConsent> {
    const result = parseTranslationConsent(
      await this.request("translation/consent", { method: "DELETE" }),
    );
    if (!result.ok) throw invalid(result.message);
    return result.data;
  }

  upload({ file, title, ownershipConfirmed, onProgress, signal }: UploadRequest): Promise<Job> {
    return new Promise((resolve, reject) => {
      const xhr = this.createXhr();
      xhr.open("POST", new URL("episodes", this.baseUrl).href);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.({ loaded: event.loaded, total: event.total });
      };
      xhr.onload = () => {
        let body: unknown;
        try {
          body = JSON.parse(xhr.responseText);
        } catch (cause) {
          reject(invalid("The worker's reply wasn't readable.", cause));
          return;
        }
        if (xhr.status === 201) {
          try {
            resolve(validJob((body as { job?: unknown }).job));
          } catch (error) {
            reject(error);
          }
        } else {
          reject(fromEnvelope(body, xhr.status));
        }
      };
      xhr.onerror = () => reject(unreachable());
      xhr.onabort = () => reject(new WorkerError("ABORTED", "The upload was cancelled."));
      signal?.addEventListener("abort", () => xhr.abort(), { once: true });

      const form = new FormData();
      form.append("file", file);
      form.append("title", title);
      form.append("ownershipConfirmed", String(ownershipConfirmed));
      xhr.send(form);
    });
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl).href, {
        ...init,
        headers: { Accept: "application/json", ...(init.headers as Record<string, string>) },
      });
    } catch (cause) {
      throw unreachable(cause);
    }
    if (response.status === 204) return null;
    let body: unknown = null;
    try {
      body = await response.json();
    } catch (cause) {
      if (response.ok) throw invalid("The worker's reply wasn't readable.", cause);
    }
    if (!response.ok) throw fromEnvelope(body, response.status);
    return body;
  }
}

function checkedJobId(id: string): string {
  if (!JOB_ID.test(id)) throw new WorkerError("NOT_FOUND", "No such job.", { status: 404 });
  return id;
}

function validJob(payload: unknown): Job {
  const result = parseJob(payload);
  if (!result.ok) throw invalid(result.message);
  return result.data;
}

function unreachable(cause?: unknown) {
  return new WorkerError("UNREACHABLE", "Pebble's local worker is not running.", {
    hint: "Start it with npm run pebble:start.",
    cause,
  });
}

function invalid(message: string, cause?: unknown) {
  return new WorkerError("INVALID_RESPONSE", message, { cause });
}

function fromEnvelope(body: unknown, status: number): WorkerError {
  const error = (body as { error?: { code?: unknown; message?: unknown; hint?: unknown } } | null)
    ?.error;
  return new WorkerError(
    typeof error?.code === "string" ? error.code : "HTTP_ERROR",
    typeof error?.message === "string" ? error.message : `The worker returned HTTP ${status}.`,
    { status, hint: typeof error?.hint === "string" ? error.hint : null },
  );
}
