import { describe, expect, it } from "vitest";
import { testTranscript } from "../../test/fixtures.tsx";
import { deriveReviewHints } from "./reviewHints.ts";

const segments = testTranscript.segments;

describe("deriveReviewHints", () => {
  it("returns nothing for null confidence and no hints", () => {
    expect(deriveReviewHints(segments, []).size).toBe(0);
  });

  it("keeps illustrative hints marked as illustrative", () => {
    const flags = deriveReviewHints(segments, [{ segmentId: "seg-2", source: "illustrative" }]);
    expect([...flags]).toEqual([["seg-2", "illustrative"]]);
  });

  it("ignores hints for unknown segments", () => {
    expect(deriveReviewHints(segments, [{ segmentId: "nope", source: "illustrative" }]).size).toBe(
      0,
    );
  });

  it("flags low provider confidence and lets it win over an illustrative hint", () => {
    const withConfidence = segments.map((s, i) => ({ ...s, confidence: i === 0 ? 0.4 : 0.95 }));
    const flags = deriveReviewHints(withConfidence, [
      { segmentId: "seg-1", source: "illustrative" },
    ]);
    expect([...flags]).toEqual([["seg-1", "provider"]]);
  });
});
