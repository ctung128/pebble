import { describe, expect, it } from "vitest";
import { parseSpeakerCorrectionsRequest } from "../src/index.ts";

const base = {
  schemaVersion: "1.9",
  episodeId: "ep-0123456789ab",
  runId: "spk-0123456789ab",
  revision: 0,
  names: {},
  merges: {},
  notSpeaker: [],
  lines: {},
};

const issuesOf = (payload: unknown) => {
  const result = parseSpeakerCorrectionsRequest(payload);
  return result.ok ? [] : result.issues;
};

describe("speaker corrections", () => {
  it("reports the same issues in the same order whatever the key order", () => {
    const a = {
      ...base,
      names: { S3: "x", S2: "y" },
      merges: { S3: "S1", S2: "S3" },
      lines: { "seg-0002": "S3", "seg-0001": "S2" },
    };
    const b = {
      ...base,
      names: { S2: "y", S3: "x" },
      merges: { S2: "S3", S3: "S1" },
      lines: { "seg-0001": "S2", "seg-0002": "S3" },
    };
    expect(issuesOf(a)).toEqual(issuesOf(b));
    expect(issuesOf(a).map((i) => i.path)).toEqual([
      "merges.S2",
      "names.S2",
      "names.S3",
      "lines.seg-0001",
      "lines.seg-0002",
    ]);
  });

  it("bounds sizes and never echoes a submitted name", () => {
    const names = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`S${i + 1}`, "Host"]));
    expect(issuesOf({ ...base, names })).toEqual([
      { path: "names", message: "at most 200 entries" },
    ]);
    const secret = "Ms Example Person";
    const tooLong = secret.repeat(5);
    const result = issuesOf({ ...base, names: { S1: tooLong } });
    expect(result).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("Example");
  });

  it("rejects non-ASCII or overlong segment keys", () => {
    expect(issuesOf({ ...base, lines: { "seg-é": "S1" } })).not.toEqual([]);
    expect(issuesOf({ ...base, lines: { ["s".repeat(65)]: "S1" } })).not.toEqual([]);
  });
});
