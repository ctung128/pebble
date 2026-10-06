import { describe, expect, it } from "vitest";
import { makeJob } from "../test/localFixtures.tsx";
import { clock, contextLine, elapsedMs, estimateLeft, tabTitle } from "./jobProgress.ts";

const running = (completedChunks: number, totalChunks: number) =>
  makeJob({ status: "running", stage: "transcribing", progress: { completedChunks, totalChunks } });

describe("estimateLeft", () => {
  // Sections finished 60 s apart: 3 done of 10, last seen at t = 120 s.
  const changes = [
    { n: 1, at: 0 },
    { n: 2, at: 60_000 },
    { n: 3, at: 120_000 },
  ];

  it("projects the measured pace over the sections left, rounding up", () => {
    expect(estimateLeft(running(3, 10), changes, 120_000)).toBe("About 7 min left");
    expect(estimateLeft(running(3, 10), changes, 150_000)).toBe("About 7 min left"); // 6.5 min
  });

  it("never counts the current section below zero when it runs long", () => {
    expect(estimateLeft(running(3, 10), changes, 400_000)).toBe("About 6 min left");
  });

  it("says less than a minute near the end", () => {
    expect(estimateLeft(running(9, 10), [...changes, { n: 9, at: 480_000 }], 500_000)).toBe(
      "Less than a minute left",
    );
  });

  it("stays quiet until two completions were seen, and outside the section stage", () => {
    expect(estimateLeft(running(1, 10), changes.slice(0, 1), 0)).toBeNull();
    expect(estimateLeft(makeJob({ status: "running", stage: "merging" }), changes, 0)).toBeNull();
    expect(estimateLeft(running(10, 10), changes, 0)).toBeNull();
  });
});

describe("progress copy", () => {
  it("formats the running clock", () => {
    expect(clock(187_400)).toBe("3:07");
  });

  it("describes the audio from measured values only", () => {
    expect(contextLine(makeJob())).toBeNull();
    expect(contextLine(makeJob({ durationMs: 42 * 60_000 }))).toBe("42 min of audio");
    expect(contextLine({ ...running(0, 1), durationMs: 20_000 })).toBe(
      "Under a minute of audio · 1 section",
    );
  });

  it("has no clock for a retry, which keeps the first attempt's start time", () => {
    const now = Date.parse("2026-10-03T12:01:00.000Z");
    expect(elapsedMs(makeJob(), now)).toBe(60_000);
    expect(elapsedMs(makeJob({ attempt: 2 }), now)).toBeNull();
  });

  it("puts progress in the tab title", () => {
    expect(tabTitle(running(4, 17), false)).toBe("(4/17) Morning walk · Pebble");
    expect(tabTitle(makeJob({ status: "running", stage: "probing" }), false)).toBe(
      "Processing · Morning walk · Pebble",
    );
    expect(tabTitle(makeJob({ status: "completed", stage: "merging" }), true)).toBe(
      "✓ Morning walk · Pebble",
    );
  });
});
