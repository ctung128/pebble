import { describe, expect, it } from "vitest";
import { listeningState, parsePlaybackRecord, type PlaybackRecord } from "./playback.ts";

const record = (overrides: Partial<PlaybackRecord> = {}): PlaybackRecord => ({
  episodeId: "ep-0123456789ab",
  positionMs: 60_000,
  durationMs: 768_000,
  updatedAt: "2026-10-05T12:00:00.000Z",
  finishedAt: null,
  ...overrides,
});

describe("parsePlaybackRecord", () => {
  it("accepts exactly the five fields", () => {
    expect(parsePlaybackRecord(record())).toEqual(record());
    const finished = record({ positionMs: 768_000, finishedAt: "2026-10-05T12:10:00.000Z" });
    expect(parsePlaybackRecord(finished)).toEqual(finished);
  });

  it.each([
    ["an extra field (nothing else may ride along)", { ...record(), title: "Morning walk" }],
    ["a bad episode id", record({ episodeId: "../x" })],
    ["a negative position", record({ positionMs: -1 })],
    ["a position past the end", record({ positionMs: 800_000 })],
    ["no duration", record({ durationMs: 0 })],
    ["a non-number", { ...record(), positionMs: "60000" }],
    ["NaN", record({ positionMs: Number.NaN })],
    ["a bad date", record({ updatedAt: "yesterday" })],
    ["a bad finish date", record({ finishedAt: "soon" })],
    ["not an object", "ep-0123456789ab"],
    ["null", null],
  ])("rejects %s", (_, row) => {
    expect(parsePlaybackRecord(row)).toBeNull();
  });
});

describe("listeningState", () => {
  it.each([
    ["no record", undefined, 768_000, "not-started"],
    ["under 5 s", record({ positionMs: 4_999 }), 768_000, "not-started"],
    ["from 5 s", record({ positionMs: 5_000 }), 768_000, "in-progress"],
    [
      "finished only by finishedAt",
      record({ finishedAt: "2026-10-05T12:10:00.000Z" }),
      768_000,
      "finished",
    ],
    ["near the end but never ended", record({ positionMs: 767_000 }), 768_000, "in-progress"],
    ["a changed duration", record(), 900_000, "not-started"],
    ["an unknown duration", record(), undefined, "not-started"],
  ] as const)("%s → %s", (_, stored, duration, state) => {
    expect(listeningState(stored, duration)).toBe(state);
  });
});
