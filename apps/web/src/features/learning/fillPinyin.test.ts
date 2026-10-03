import { describe, expect, it, vi } from "vitest";
import type { LearningItem } from "@pebble/schema";
import { testEpisode, testTranscript } from "../../test/fixtures.tsx";
import { buildLearningItem } from "./buildLearningItem.ts";
import { fillPinyin } from "./fillPinyin.ts";

const item = (index: number, overrides: Partial<LearningItem> = {}): LearningItem => ({
  ...buildLearningItem({
    episode: testEpisode,
    transcript: testTranscript,
    segment: testTranscript.segments[index]!,
    correction: null,
    pinyin: null,
    translation: null,
    id: `item-${index}`,
  }),
  ...overrides,
});

describe("fillPinyin", () => {
  it("generates pinyin for items saved without it", async () => {
    const result = await fillPinyin([item(0), item(1)]);
    expect(result.items.map((i) => i.pinyin)).toEqual(["dì yī jù。", "dì èr jù。"]);
    expect(result.filled).toHaveLength(2);
    expect(result.failed).toBe(false);
  });

  it("uses the saved (edited) text", async () => {
    const edited = item(0, { text: "第一句话。", originalText: "第一句。" });
    const [result] = (await fillPinyin([edited])).items;
    expect(result!.pinyin).toBe("dì yī jù huà。");
  });

  it("keeps existing pinyin and skips loading when nothing is missing", async () => {
    const load = vi.fn();
    const result = await fillPinyin([item(0, { pinyin: "kept" })], load);
    expect(result.items[0]!.pinyin).toBe("kept");
    expect(load).not.toHaveBeenCalled();
  });

  it("leaves pinyin blank and reports failure when the module can't load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await fillPinyin([item(0)], () => Promise.reject(new Error("offline")));
    expect(result).toMatchObject({ failed: true, filled: [] });
    expect(result.items[0]!.pinyin).toBeNull();
    warn.mockRestore();
  });
});
