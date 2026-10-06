import { describe, expect, it } from "vitest";
import { REPLAY_PREROLL_MS, replayStartMs } from "./replayStart.ts";

const lines = (...starts: number[]) => starts.map((startMs) => ({ startMs }));

describe("replayStartMs", () => {
  it("starts 200 ms early", () => {
    expect(REPLAY_PREROLL_MS).toBe(200);
    expect(replayStartMs(lines(0, 3000, 6000), 2)).toBe(5800);
  });

  it("keeps the full pre-roll when lines touch or overlap (the floor is the previous start)", () => {
    // Touching: the previous line ends exactly at 3000. Overlapping: it ends at 3400.
    // Either way the floor is its start (1000), so the pre-roll is not cancelled.
    expect(replayStartMs(lines(1000, 3000), 1)).toBe(2800);
  });

  it("never starts before 0 for the first line", () => {
    expect(replayStartMs(lines(150, 3000), 0)).toBe(0);
    expect(replayStartMs(lines(1000, 3000), 0)).toBe(800);
  });

  it("shortens the pre-roll only for a previous line shorter than it", () => {
    expect(replayStartMs(lines(0, 2880, 3000), 2)).toBe(2880);
    expect(replayStartMs(lines(0, 3000, 3000), 2)).toBe(3000); // same start: no pre-roll
  });

  it("returns 0 for a line that doesn't exist", () => {
    expect(replayStartMs(lines(0, 3000), 5)).toBe(0);
    expect(replayStartMs([], 0)).toBe(0);
  });
});
