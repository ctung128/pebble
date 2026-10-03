import { describe, expect, it } from "vitest";
import { formatTime } from "./formatTime.ts";

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
