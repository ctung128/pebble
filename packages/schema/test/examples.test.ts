import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseCorrection,
  parseDemoTranslations,
  parseIllustrativeUncertainty,
  parseJob,
  parseLearningItem,
  parseManifest,
  parseTranscript,
  parseWorkerHealth,
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
  ["job", parseJob],
  ["worker-health", parseWorkerHealth],
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

interface Expectation {
  code: ContractErrorCode;
  path: string;
  message: string;
}
/** Shared with the Python worker's contract tests. */
const expectations = load("expectations.json") as { invalid: Record<string, Expectation> };
const invalidCases = expectations.invalid;

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
      message: expect.stringMatching(new RegExp(expected.message)),
    });
  });
});
