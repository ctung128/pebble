import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, SchemaVersionSchema } from "./common.ts";

/**
 * Optional DeepL line translation (1.8; docs/TRANSLATION.md, ADR 0008). These shapes are shared
 * by the local worker and the local app. None of them carries the API key or a provider's own
 * error text.
 */

export const TRANSLATION_PROVIDER = "deepl";
export const TRANSLATION_TARGET_LANGUAGE = "EN-US";
export const TRANSLATION_CACHE_VERSION = 1;
/** Longest Chinese line that may be sent, in Unicode code points. */
export const MAX_TRANSLATION_SOURCE_CODE_POINTS = 300;
/** Longest English accepted back from the provider, in Unicode code points. */
export const MAX_TRANSLATION_RESULT_CODE_POINTS = 2000;

/**
 * Han ideographs that count as "Chinese" for the eligibility rule: CJK Unified Ideographs and
 * Extension A, Compatibility Ideographs, and the supplementary-plane extensions. The worker uses
 * the same ranges (contract.py); shared cases live in examples/translation-text.json.
 */
const HAN_RANGES: readonly (readonly [number, number])[] = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x20000, 0x2fa1f],
  [0x30000, 0x323af],
];

const isHan = (cp: number) => HAN_RANGES.some(([low, high]) => cp >= low && cp <= high);
const isSurrogate = (cp: number) => cp >= 0xd800 && cp <= 0xdfff;
/** Unicode general category Cc: C0, DEL and C1. */
const isControl = (cp: number) => cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
const isAllowedWhitespaceControl = (cp: number) => cp === 0x09 || cp === 0x0a || cp === 0x0d;

export type TranslationTextProblem = "surrogate" | "control" | "length" | "nfc" | "chinese";

export const TRANSLATION_TEXT_MESSAGES: Record<TranslationTextProblem, string> = {
  surrogate: "text must not contain unpaired surrogates",
  control: "text must not contain control characters",
  length: `text must be 1 to ${MAX_TRANSLATION_SOURCE_CODE_POINTS} Unicode code points`,
  nfc: "text must be NFC-normalized",
  chinese: "text must contain a Chinese character",
};

/**
 * The first rule a Chinese line breaks, checked in this order: surrogate, control, length, nfc,
 * chinese. `null` means it may be sent exactly as given (no trimming or other changes).
 */
export function translationTextProblem(text: string): TranslationTextProblem | null {
  const codePoints = Array.from(text, (char) => char.codePointAt(0) ?? 0);
  if (codePoints.some(isSurrogate)) return "surrogate";
  if (codePoints.some(isControl)) return "control";
  if (codePoints.length < 1 || codePoints.length > MAX_TRANSLATION_SOURCE_CODE_POINTS) {
    return "length";
  }
  if (text.normalize("NFC") !== text) return "nfc";
  if (!codePoints.some(isHan)) return "chinese";
  return null;
}

/** A Chinese line as it may be submitted for translation. */
export const TranslationSourceTextSchema = z.string().superRefine((text, ctx) => {
  const problem = translationTextProblem(text);
  if (problem) ctx.addIssue({ code: "custom", message: TRANSLATION_TEXT_MESSAGES[problem] });
});

/** English returned by the provider: non-empty, bounded, no control characters but whitespace. */
export const TranslatedTextSchema = z.string().superRefine((text, ctx) => {
  const codePoints = Array.from(text, (char) => char.codePointAt(0) ?? 0);
  const message =
    text.trim().length === 0
      ? "text must not be empty"
      : codePoints.length > MAX_TRANSLATION_RESULT_CODE_POINTS
        ? `text must be at most ${MAX_TRANSLATION_RESULT_CODE_POINTS} Unicode code points`
        : codePoints.some(isSurrogate)
          ? "text must not contain unpaired surrogates"
          : codePoints.some((cp) => isControl(cp) && !isAllowedWhitespaceControl(cp))
            ? "text must not contain control characters"
            : null;
  if (message) ctx.addIssue({ code: "custom", message });
});

/** SHA-256 of the exact submitted text's UTF-8 bytes, as lowercase hex. */
export const SourceFingerprintSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected a SHA-256 fingerprint (64 lowercase hex characters)");

export const ConsentVersionSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{0,63}$/, "expected a consent version");

const ProviderSchema = z.literal(TRANSLATION_PROVIDER);
const TargetLanguageSchema = z.literal(TRANSLATION_TARGET_LANGUAGE);

/** Fixed error codes for translation routes (TRANSLATION.md); messages are fixed copy. */
export const TranslationErrorCodeSchema = z.enum([
  "TRANSLATION_OFF",
  "TRANSLATION_CONSENT_REQUIRED",
  "TRANSLATION_LOCAL_LIMIT",
  "TRANSLATION_RATE_LIMITED",
  "TRANSLATION_PROVIDER_QUOTA",
  "TRANSLATION_KEY_REJECTED",
  "TRANSLATION_REQUEST_REJECTED",
  "TRANSLATION_UNAVAILABLE",
  "TRANSLATION_INVALID_TEXT",
  "TRANSLATION_NOT_ALLOWED",
  "EPISODE_NOT_FOUND",
  "SEGMENT_NOT_FOUND",
]);

// --- Worker health (1.8, optional) -------------------------------------------------------

export const TranslationConsentStateSchema = z.enum(["current", "required", "not_configured"]);
export const TranslationNewRequestsSchema = z.enum([
  "available",
  "consent_required",
  "local_limit_reached",
  "off",
]);

const PeriodSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "expected a UTC calendar month (YYYY-MM)");

export const TranslationLimitsSchema = z.object({
  period: PeriodSchema,
  requestsUsed: z.number().int().nonnegative(),
  requestLimit: z.number().int().positive(),
  charactersUsed: z.number().int().nonnegative(),
  characterLimit: z.number().int().positive(),
});

/**
 * Translation readiness in worker health. Separate facts: whether a provider is configured,
 * whether consent is current, and whether a new request may be sent. Reading cached English
 * never depends on them.
 */
export const TranslationHealthSchema = z
  .object({
    provider: ProviderSchema,
    configured: z.boolean(),
    consent: TranslationConsentStateSchema,
    /** The consent version a learner must accept now. */
    consentVersion: ConsentVersionSchema,
    newRequests: TranslationNewRequestsSchema,
    limits: TranslationLimitsSchema,
  })
  .superRefine((health, ctx) => {
    for (const issue of translationHealthIssues(health)) ctx.addIssue({ code: "custom", ...issue });
  });

interface HealthFacts {
  configured: boolean;
  consent: z.infer<typeof TranslationConsentStateSchema>;
  newRequests: z.infer<typeof TranslationNewRequestsSchema>;
  limits: z.infer<typeof TranslationLimitsSchema>;
}

function translationHealthIssues(h: HealthFacts): { path: string[]; message: string }[] {
  const atLimit =
    h.limits.requestsUsed >= h.limits.requestLimit ||
    h.limits.charactersUsed >= h.limits.characterLimit;
  if (!h.configured) {
    return [
      ...(h.consent === "not_configured"
        ? []
        : [{ path: ["consent"], message: "consent must be not_configured when not configured" }]),
      ...(h.newRequests === "off"
        ? []
        : [{ path: ["newRequests"], message: "newRequests must be off when not configured" }]),
    ];
  }
  if (h.consent === "not_configured") {
    return [{ path: ["consent"], message: "consent must be current or required when configured" }];
  }
  const expected =
    h.consent === "required" ? "consent_required" : atLimit ? "local_limit_reached" : "available";
  return h.newRequests === expected
    ? []
    : [{ path: ["newRequests"], message: `newRequests must be ${expected} here` }];
}

export type TranslationHealth = z.infer<typeof TranslationHealthSchema>;

// --- Requests and responses --------------------------------------------------------------

/** POST /translations: one displayed line, on an explicit tap. */
export const TranslationRequestSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  episodeId: IdSchema,
  segmentId: z.string().min(1),
  text: TranslationSourceTextSchema,
});

/** A translation of one line, from the cache or just made. */
export const TranslationResultSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  episodeId: IdSchema,
  segmentId: z.string().min(1),
  fingerprint: SourceFingerprintSchema,
  provider: ProviderSchema,
  targetLanguage: TargetLanguageSchema,
  text: TranslatedTextSchema,
  /** "cache": no request was sent for this answer. */
  source: z.enum(["cache", "provider"]),
  createdAt: IsoDateTimeSchema,
});

/** GET /episodes/{id}/translations: the episode's cached English, read-only. */
export const EpisodeTranslationsSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    episodeId: IdSchema,
    provider: ProviderSchema,
    targetLanguage: TargetLanguageSchema,
    cacheVersion: z.literal(TRANSLATION_CACHE_VERSION),
    translations: z.array(
      z.object({
        segmentId: z.string().min(1),
        fingerprint: SourceFingerprintSchema,
        text: TranslatedTextSchema,
        createdAt: IsoDateTimeSchema,
      }),
    ),
  })
  .superRefine((payload, ctx) => {
    const seen = new Set<string>();
    payload.translations.forEach((row, i) => {
      const key = `${row.segmentId}\u0000${row.fingerprint}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["translations", i, "fingerprint"],
          message: "duplicate translation for this segment and fingerprint",
        });
      }
      seen.add(key);
    });
  });

/** PUT /translation/consent: accept the consent version shown in the dialog. */
export const TranslationConsentRequestSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  provider: ProviderSchema,
  consentVersion: ConsentVersionSchema,
});

/** Consent as the worker holds it, shared by every browser using this worker. */
export const TranslationConsentSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    provider: ProviderSchema,
    status: z.enum(["current", "required"]),
    /** The version a learner must accept now. */
    consentVersion: ConsentVersionSchema,
    /** When the current version was accepted; null unless status is current. */
    grantedAt: IsoDateTimeSchema.nullable(),
  })
  .superRefine((consent, ctx) => {
    if ((consent.status === "current") !== (consent.grantedAt !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["grantedAt"],
        message: "grantedAt must be set exactly when consent is current",
      });
    }
  });

export type TranslationRequest = z.infer<typeof TranslationRequestSchema>;
export type TranslationResult = z.infer<typeof TranslationResultSchema>;
export type EpisodeTranslations = z.infer<typeof EpisodeTranslationsSchema>;
export type TranslationConsentRequest = z.infer<typeof TranslationConsentRequestSchema>;
export type TranslationConsent = z.infer<typeof TranslationConsentSchema>;
export type TranslationErrorCode = z.infer<typeof TranslationErrorCodeSchema>;

/**
 * What a learner may do, from worker health. An older worker (no `translation` field) means
 * translation is off: new requests are unavailable and nothing may be sent.
 */
export function translationAvailability(translation: TranslationHealth | undefined): {
  configured: boolean;
  newRequests: z.infer<typeof TranslationNewRequestsSchema>;
} {
  if (!translation) return { configured: false, newRequests: "off" };
  return { configured: translation.configured, newRequests: translation.newRequests };
}
