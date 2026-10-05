import { describe, expect, it } from "vitest";
import { formatDuration, formatTime } from "./formatTime.ts";

describe("formatTime", () => {
  it.each([
    [0, "0:00"],
    [999, "0:00"],
    [1_000, "0:01"],
    [75_000, "1:15"],
    [3_725_000, "1:02:05"],
    [-5, "0:00"],
    [Number.NaN, "0:00"],
  ])("%d ms → %s", (ms, expected) => {
    expect(formatTime(ms)).toBe(expected);
  });
});

describe("formatDuration", () => {
  it.each([
    [undefined, null],
    [null, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [-1_000, null],
    [0, null],
    [999, null],
    [1_000, "0:01"],
    [768_000, "12:48"],
    [3_599_000, "59:59"],
    [3_600_000, "1:00:00"],
    [4_935_000, "1:22:15"],
  ])("%s ms → %s (never 0:00 for a missing length)", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});
