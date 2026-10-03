import { describe, expect, it } from "vitest";
import { findActiveSegmentIndex } from "./activeSegment.ts";

const segments = [
  { startMs: 300, endMs: 3000 },
  { startMs: 3500, endMs: 6000 },
  { startMs: 6500, endMs: 9000 },
];

describe("findActiveSegmentIndex", () => {
  it.each([
    [0, -1, "before the first segment"],
    [300, 0, "exactly at a start"],
    [2999, 0, "inside a segment"],
    [3200, 0, "in the gap after a segment"],
    [3500, 1, "at the next start"],
    [8999, 2, "inside the last segment"],
    [60_000, 2, "after the last segment"],
  ])("t=%d → %d (%s)", (time, expected) => {
    expect(findActiveSegmentIndex(segments, time)).toBe(expected);
  });

  it("returns -1 for an empty transcript", () => {
    expect(findActiveSegmentIndex([], 1000)).toBe(-1);
  });
});
