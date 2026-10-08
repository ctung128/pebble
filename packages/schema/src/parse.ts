import type { z } from "zod";
import { CorrectionSchema, type Correction } from "./correction.ts";
import { WorkerHealthSchema, type WorkerHealth } from "./health.ts";
import { IllustrativeUncertaintySchema, type IllustrativeUncertainty } from "./illustrative.ts";
import { JobSchema, type Job } from "./job.ts";
import { LearningItemSchema, type LearningItem } from "./learningItem.ts";
import {
  EpisodeTranslationsSchema,
  TranslationConsentRequestSchema,
  TranslationConsentSchema,
  TranslationRequestSchema,
  TranslationResultSchema,
  type EpisodeTranslations,
  type TranslationConsent,
  type TranslationConsentRequest,
  type TranslationRequest,
  type TranslationResult,
} from "./lineTranslation.ts";
import { ManifestSchema, type Manifest } from "./manifest.ts";
import {
  EpisodeSpeakersSchema,
  SpeakerCorrectionsRequestSchema,
  SpeakerRunRequestSchema,
  type EpisodeSpeakers,
  type SpeakerCorrectionsRequest,
  type SpeakerRunRequest,
} from "./speakers.ts";
import { DemoTranslationsSchema, type DemoTranslations } from "./translations.ts";
import { TranscriptSchema, type Transcript } from "./transcript.ts";
import { checkSchemaVersion, SUPPORTED_MAJOR } from "./version.ts";

export type ContractErrorCode = "INVALID_PAYLOAD" | "UNSUPPORTED_VERSION";

export interface ContractIssue {
  path: string;
  message: string;
}

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ContractErrorCode; message: string; issues: ContractIssue[] };

function parseWith<T>(schema: z.ZodType<T>, payload: unknown, label: string): ParseResult<T> {
  const version = checkSchemaVersion(payload);
  if (!version.ok) {
    const unsupported = version.reason === "unsupported";
    return {
      ok: false,
      code: unsupported ? "UNSUPPORTED_VERSION" : "INVALID_PAYLOAD",
      message: unsupported
        ? `${label} schemaVersion ${String(version.found)} is not supported (expected ${SUPPORTED_MAJOR}.x)`
        : `${label} schemaVersion is ${version.reason}`,
      issues: [{ path: "schemaVersion", message: version.reason }],
    };
  }

  const result = schema.safeParse(payload);
  if (result.success) return { ok: true, data: result.data };

  const issues = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
  const first = issues[0];
  return {
    ok: false,
    code: "INVALID_PAYLOAD",
    message: `${label} is invalid${first ? `: ${first.path || "(root)"} — ${first.message}` : ""}`,
    issues,
  };
}

export const parseManifest = (payload: unknown): ParseResult<Manifest> =>
  parseWith(ManifestSchema, payload, "Manifest");

export const parseTranscript = (payload: unknown): ParseResult<Transcript> =>
  parseWith(TranscriptSchema, payload, "Transcript");

export const parseDemoTranslations = (payload: unknown): ParseResult<DemoTranslations> =>
  parseWith(DemoTranslationsSchema, payload, "Translations");

export const parseIllustrativeUncertainty = (
  payload: unknown,
): ParseResult<IllustrativeUncertainty> =>
  parseWith(IllustrativeUncertaintySchema, payload, "Illustrative uncertainty");

export const parseCorrection = (payload: unknown): ParseResult<Correction> =>
  parseWith(CorrectionSchema, payload, "Correction");

export const parseLearningItem = (payload: unknown): ParseResult<LearningItem> =>
  parseWith(LearningItemSchema, payload, "Learning item");

export const parseJob = (payload: unknown): ParseResult<Job> =>
  parseWith(JobSchema, payload, "Job");

export const parseWorkerHealth = (payload: unknown): ParseResult<WorkerHealth> =>
  parseWith(WorkerHealthSchema, payload, "Worker health");

export const parseTranslationRequest = (payload: unknown): ParseResult<TranslationRequest> =>
  parseWith(TranslationRequestSchema, payload, "Translation request");

export const parseTranslationResult = (payload: unknown): ParseResult<TranslationResult> =>
  parseWith(TranslationResultSchema, payload, "Translation");

export const parseEpisodeTranslations = (payload: unknown): ParseResult<EpisodeTranslations> =>
  parseWith(EpisodeTranslationsSchema, payload, "Episode translations");

export const parseTranslationConsentRequest = (
  payload: unknown,
): ParseResult<TranslationConsentRequest> =>
  parseWith(TranslationConsentRequestSchema, payload, "Translation consent request");

export const parseTranslationConsent = (payload: unknown): ParseResult<TranslationConsent> =>
  parseWith(TranslationConsentSchema, payload, "Translation consent");

export const parseSpeakerCorrectionsRequest = (
  payload: unknown,
): ParseResult<SpeakerCorrectionsRequest> =>
  parseWith(SpeakerCorrectionsRequestSchema, payload, "Speaker corrections");

export const parseEpisodeSpeakers = (payload: unknown): ParseResult<EpisodeSpeakers> =>
  parseWith(EpisodeSpeakersSchema, payload, "Episode speakers");

export const parseSpeakerRunRequest = (payload: unknown): ParseResult<SpeakerRunRequest> =>
  parseWith(SpeakerRunRequestSchema, payload, "Speaker run request");
