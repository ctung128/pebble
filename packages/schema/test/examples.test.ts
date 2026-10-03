import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseCorrection,
  parseDemoTranslations,
  parseIllustrativeUncertainty,
  parseLearningItem,
  parseManifest,
  parseTranscript,
  type ContractErrorCode,
  type ParseResult,
} from "../src/index.ts";

const examplesDir = new URL("../examples/", import.meta.url);
const load = (relative: string): unknown =>
  JSON.parse(readFileSync(new URL(relative, examplesDir), "utf8"));
const PARSERS: [prefix: string, parse: (payload: unknown) => ParseResult<unknown>][] = [
  ["manifest", parseManifest],
  ["transcript", parseTranscript],
  ["demo-translations", parseDemoTranslations],
  ["illustrative-uncertainty", parseIllustrativeUncertainty],
  ["correction", parseCorrection],
  ["learning-item", parseLearningItem],
];
const parserFor = (file: string) => {
  const entry = PARSERS.find(([prefix]) => file.startsWith(prefix));
  if (!entry) throw new Error(`No parser for example ${file}`);
  return entry[1];
};

describe("valid examples", () => {
  it.each(readdirSync(new URL("valid/", examplesDir)).sort())("accepts %s", (file) => {
    const result = parserFor(file)(load(`valid/${file}`));
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it("accepts the transcript example and drops unknown fields", () => {
    const result = parseTranscript(load("valid/transcript.json"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).not.toHaveProperty("futureField");
  });
});

const invalidCases: Record<string, { code: ContractErrorCode; path: string; message: RegExp }> = {
  "transcript-unsorted.json": {
    code: "INVALID_PAYLOAD",
    path: "segments.2.startMs",
    message: /ordered by startMs/,
  },
  "transcript-end-before-start.json": {
    code: "INVALID_PAYLOAD",
    path: "segments.1.endMs",
    message: /after startMs/,
  },
  "transcript-duplicate-ids.json": {
    code: "INVALID_PAYLOAD",
    path: "segments.1.id",
    message: /duplicate segment id/,
  },
  "transcript-unsupported-version.json": {
    code: "UNSUPPORTED_VERSION",
    path: "schemaVersion",
    message: /unsupported/,
  },
  "transcript-confidence-out-of-range.json": {
    code: "INVALID_PAYLOAD",
    path: "segments.0.confidence",
    message: /./,
  },
  "transcript-empty-text.json": {
    code: "INVALID_PAYLOAD",
    path: "segments.1.text",
    message: /must not be empty/,
  },
  "demo-translations-model-kind.json": {
    code: "INVALID_PAYLOAD",
    path: "kind",
    message: /./,
  },
  "illustrative-uncertainty-wrong-kind.json": {
    code: "INVALID_PAYLOAD",
    path: "kind",
    message: /./,
  },
  "correction-empty-text.json": {
    code: "INVALID_PAYLOAD",
    path: "correctedText",
    message: /must not be empty/,
  },
  "learning-item-corrected-without-original.json": {
    code: "INVALID_PAYLOAD",
    path: "originalText",
    message: /exactly when the item was corrected/,
  },
  "learning-item-phrase-kind.json": {
    code: "INVALID_PAYLOAD",
    path: "kind",
    message: /./,
  },
  "manifest-path-traversal.json": {
    code: "INVALID_PAYLOAD",
    path: "episodes.0.audio.src",
    message: /relative path/,
  },
};

describe("invalid examples", () => {
  it("has an expectation for every file in examples/invalid", () => {
    const files = readdirSync(new URL("invalid/", examplesDir)).sort();
    expect(files).toEqual(Object.keys(invalidCases).sort());
  });

  it.each(Object.entries(invalidCases))("rejects %s", (file, expected) => {
    const result = parserFor(file)(load(`invalid/${file}`));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(expected.code);
    expect(result.issues).toContainEqual({
      path: expected.path,
      message: expect.stringMatching(expected.message),
    });
  });
});
