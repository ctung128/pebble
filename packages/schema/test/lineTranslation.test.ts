import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EpisodeTranslationsSchema,
  TranslationConsentRequestSchema,
  TranslationConsentSchema,
  TranslationHealthSchema,
  TranslationRequestSchema,
  TranslationResultSchema,
  parseTranslationRequest,
  parseTranslationResult,
  parseWorkerHealth,
  translationAvailability,
  translationTextProblem,
  type TranslationHealth,
} from "../src/index.ts";

const examplesDir = new URL("../examples/", import.meta.url);
const load = (relative: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(relative, examplesDir), "utf8")) as Record<string, unknown>;

interface TextCase {
  name: string;
  text: string;
  reason: string | null;
}
/** Shared with the Python worker's contract tests. */
const textCases = (load("translation-text.json") as unknown as { cases: TextCase[] }).cases;

describe("translation text rules (shared cases)", () => {
  it.each(textCases.map((c) => [c.name, c] as const))("%s", (_, c) => {
    expect(translationTextProblem(c.text)).toBe(c.reason);
  });

  it("counts code points, not UTF-16 units", () => {
    const astral = "\u{20BB7}".repeat(300);
    expect(astral.length).toBe(600);
    expect(translationTextProblem(astral)).toBeNull();
  });

  it("keeps the text exactly as submitted", () => {
    const request = {
      schemaVersion: "1.8",
      episodeId: "example-001",
      segmentId: "seg-0001",
      text: "  他说 OK 吧。 ",
    };
    const result = parseTranslationRequest(request);
    expect(result.ok && result.data.text).toBe(request.text);
  });
});

const limits = {
  period: "2026-10",
  requestsUsed: 0,
  requestLimit: 300,
  charactersUsed: 0,
  characterLimit: 30000,
};
const health = (overrides: Partial<TranslationHealth>) => ({
  provider: "deepl",
  configured: true,
  consent: "current",
  consentVersion: "deepl-2026-10",
  newRequests: "available",
  limits,
  ...overrides,
});

describe("translation health", () => {
  it.each([
    ["not configured", { configured: false, consent: "not_configured", newRequests: "off" }],
    ["needs consent", { consent: "required", newRequests: "consent_required" }],
    ["ready", {}],
    [
      "request limit reached",
      { newRequests: "local_limit_reached", limits: { ...limits, requestsUsed: 300 } },
    ],
    [
      "character limit reached",
      { newRequests: "local_limit_reached", limits: { ...limits, charactersUsed: 30000 } },
    ],
    [
      "usage above a lowered limit",
      { newRequests: "local_limit_reached", limits: { ...limits, requestsUsed: 301 } },
    ],
    [
      "needs consent even at the limit",
      {
        consent: "required",
        newRequests: "consent_required",
        limits: { ...limits, requestsUsed: 300 },
      },
    ],
  ] as const)("accepts %s", (_, overrides) => {
    const result = TranslationHealthSchema.safeParse(
      health(overrides as Partial<TranslationHealth>),
    );
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });

  it.each([
    ["off but available", { configured: false, consent: "not_configured" }, "newRequests"],
    ["not configured but consent current", { configured: false, newRequests: "off" }, "consent"],
    ["configured without a consent state", { consent: "not_configured" }, "consent"],
    ["consent required but available", { consent: "required" }, "newRequests"],
    ["ready reported as off", { newRequests: "off" }, "newRequests"],
    ["available at the limit", { limits: { ...limits, requestsUsed: 300 } }, "newRequests"],
    ["limit reached below the limit", { newRequests: "local_limit_reached" }, "newRequests"],
    ["unknown provider", { provider: "other" }, "provider"],
    ["bad period", { limits: { ...limits, period: "2026-13" } }, "limits"],
    ["zero limit", { limits: { ...limits, requestLimit: 0 } }, "limits"],
    ["bad consent version", { consentVersion: "Bad Version" }, "consentVersion"],
  ] as const)("rejects %s", (_, overrides, path) => {
    const result = TranslationHealthSchema.safeParse(
      health(overrides as Partial<TranslationHealth>),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((i) => i.path[0])).toContain(path);
  });

  it("reads 1.7 and older health without a translation field as off", () => {
    for (const file of ["valid/worker-health.json", "valid/worker-health-instance.json"]) {
      const result = parseWorkerHealth(load(file));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.data.translation).toBeUndefined();
      expect(translationAvailability(result.data.translation)).toEqual({
        configured: false,
        newRequests: "off",
      });
    }
  });

  it("reports a configured worker's state as given", () => {
    const result = parseWorkerHealth(load("valid/worker-health-translation.json"));
    expect(result.ok && translationAvailability(result.data.translation)).toEqual({
      configured: true,
      newRequests: "available",
    });
  });
});

const result = {
  schemaVersion: "1.8",
  episodeId: "example-001",
  segmentId: "seg-0001",
  fingerprint: "a".repeat(64),
  provider: "deepl",
  targetLanguage: "EN-US",
  text: "Invented English.",
  source: "provider",
  createdAt: "2026-10-06T12:00:00Z",
};

describe("malformed translation payloads", () => {
  it.each([
    [
      "request without text",
      TranslationRequestSchema,
      { schemaVersion: "1.8", episodeId: "example-001", segmentId: "seg-0001" },
    ],
    [
      "request with numeric text",
      TranslationRequestSchema,
      { schemaVersion: "1.8", episodeId: "example-001", segmentId: "seg-0001", text: 5 },
    ],
    [
      "request with an empty segment id",
      TranslationRequestSchema,
      { schemaVersion: "1.8", episodeId: "example-001", segmentId: "", text: "好" },
    ],
    [
      "request with a bad episode id",
      TranslationRequestSchema,
      { schemaVersion: "1.8", episodeId: "Episode 1", segmentId: "seg-0001", text: "好" },
    ],
    [
      "result with an uppercase fingerprint",
      TranslationResultSchema,
      { ...result, fingerprint: "A".repeat(64) },
    ],
    [
      "result with a short fingerprint",
      TranslationResultSchema,
      { ...result, fingerprint: "a".repeat(63) },
    ],
    [
      "result with another target language",
      TranslationResultSchema,
      { ...result, targetLanguage: "EN-GB" },
    ],
    ["result with an unknown source", TranslationResultSchema, { ...result, source: "browser" }],
    ["result with too much text", TranslationResultSchema, { ...result, text: "a".repeat(2001) }],
    [
      "result with a control character",
      TranslationResultSchema,
      { ...result, text: "Invented\u0000English." },
    ],
    [
      "result with an unpaired surrogate",
      TranslationResultSchema,
      { ...result, text: "Invented \ud800" },
    ],
    [
      "cache with another cache version",
      EpisodeTranslationsSchema,
      {
        schemaVersion: "1.8",
        episodeId: "example-001",
        provider: "deepl",
        targetLanguage: "EN-US",
        cacheVersion: 2,
        translations: [],
      },
    ],
    [
      "consent request without a version",
      TranslationConsentRequestSchema,
      { schemaVersion: "1.8", provider: "deepl" },
    ],
    [
      "consent required with a grant time",
      TranslationConsentSchema,
      {
        schemaVersion: "1.8",
        provider: "deepl",
        status: "required",
        consentVersion: "deepl-2026-10",
        grantedAt: "2026-10-06T12:00:00Z",
      },
    ],
    [
      "consent with an unknown status",
      TranslationConsentSchema,
      {
        schemaVersion: "1.8",
        provider: "deepl",
        status: "withdrawn",
        consentVersion: "deepl-2026-10",
        grantedAt: null,
      },
    ],
  ] as const)("rejects %s", (_, schema, payload) => {
    expect(schema.safeParse(payload).success).toBe(false);
  });

  it("accepts whitespace inside a translation", () => {
    expect(
      TranslationResultSchema.safeParse({ ...result, text: "Invented,\tEnglish." }).success,
    ).toBe(true);
  });
});

describe("no key or raw provider error in public payloads", () => {
  const FORBIDDEN = /key|auth|secret|token|raw|providerMessage|providerError|detail/i;
  const shapes = {
    TranslationHealthSchema: TranslationHealthSchema,
    TranslationRequestSchema,
    TranslationResultSchema,
    EpisodeTranslationsSchema,
    TranslationConsentRequestSchema,
    TranslationConsentSchema,
  };

  it.each(Object.entries(shapes))("%s declares no such field", (_, schema) => {
    const keys = JSON.stringify(schema.toJSONSchema({ unrepresentable: "any" }).properties);
    for (const name of Object.keys(JSON.parse(keys) as Record<string, unknown>)) {
      expect(name).not.toMatch(FORBIDDEN);
    }
  });

  it("drops such fields if a payload carries them", () => {
    const parsed = parseTranslationResult({
      ...result,
      authKey: "invented-not-a-key",
      providerMessage: "invented provider text",
      raw: { anything: true },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(Object.keys(parsed.data)).not.toEqual(
        expect.arrayContaining(["authKey", "providerMessage", "raw"]),
      );
    }
  });
});

describe("schemaVersion on translation requests", () => {
  const body = { episodeId: "example-001", segmentId: "seg-0001", text: "好" };

  it.each(["1.7", "1.8", "1.9"])("accepts %s (any 1.x)", (schemaVersion) => {
    expect(parseTranslationRequest({ ...body, schemaVersion }).ok).toBe(true);
  });

  it.each([
    ["missing", undefined, "INVALID_PAYLOAD"],
    ["not a string", 1.8, "INVALID_PAYLOAD"],
    ["malformed", "1.8.0", "INVALID_PAYLOAD"],
    ["another major", "2.0", "UNSUPPORTED_VERSION"],
  ] as const)("rejects %s", (_, schemaVersion, code) => {
    const result = parseTranslationRequest({ ...body, schemaVersion });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code);
  });
});
