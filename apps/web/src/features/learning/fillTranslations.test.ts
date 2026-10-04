import { describe, expect, it, vi } from "vitest";
import type { LearningItem } from "@pebble/schema";
import { fakeTranslationProvider, testEpisode, testTranscript } from "../../test/fixtures.tsx";
import { TranslationError } from "../translation/TranslationProvider.ts";
import { buildLearningItem } from "./buildLearningItem.ts";
import { fillTranslations } from "./fillTranslations.ts";

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

describe("fillTranslations", () => {
  it("never requests English for items from local speech-recognition transcripts", async () => {
    const { provider, translate } = fakeTranslationProvider();
    const asr = item(0, {
      id: "item-asr",
      provenance: { ...item(0).provenance, transcriptKind: "asr", transcriptProvider: "funasr" },
    });
    const result = await fillTranslations([asr, item(1)], provider);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledWith(expect.objectContaining({ segmentId: "seg-2" }));
    expect(result.items[0]!.translation).toBeNull();
    expect(result.filled.map((i) => i.id)).toEqual(["item-1"]);
    expect(result.missingUnavailable).toBe(0); // not reported as a failed translation
    expect(result.missingEdited).toBe(0);
  });

  it("fills missing translations and reports which items changed", async () => {
    const { provider, translate } = fakeTranslationProvider();
    const input = [item(0), item(1)];
    const result = await fillTranslations(input, provider, new Date("2026-10-04T00:00:00Z"));
    expect(result.items.map((i) => i.translation)).toEqual([
      "The first sentence.",
      "The second sentence.",
    ]);
    expect(result.filled.map((i) => i.id)).toEqual(["item-0", "item-1"]);
    expect(result.filled[0]!.updatedAt).toBe("2026-10-04T00:00:00.000Z");
    expect(translate).toHaveBeenCalledTimes(2);
    expect(input[0]!.translation).toBeNull(); // inputs are not mutated
  });

  it("keeps existing translations without requesting them", async () => {
    const { provider, translate } = fakeTranslationProvider();
    const result = await fillTranslations([item(0, { translation: "Mine." })], provider);
    expect(result.items[0]!.translation).toBe("Mine.");
    expect(result.filled).toEqual([]);
    expect(translate).not.toHaveBeenCalled();
  });

  it("leaves edited lines blank and counts them separately", async () => {
    const { provider } = fakeTranslationProvider();
    const edited = item(0, {
      text: "第一句话。",
      originalText: "第一句。",
      provenance: { ...item(0).provenance, corrected: true },
    });
    const result = await fillTranslations([edited, item(1)], provider);
    expect(result.items[0]!.translation).toBeNull();
    expect(result.items[1]!.translation).toBe("The second sentence.");
    expect(result).toMatchObject({ missingEdited: 1, missingUnavailable: 0 });
  });

  it("leaves items blank when the provider is unavailable", async () => {
    const translate = vi.fn(async () => {
      throw new TranslationError("UNAVAILABLE", "down");
    });
    const result = await fillTranslations([item(0), item(1)], { id: "x", translate });
    expect(result.items.every((i) => i.translation === null)).toBe(true);
    expect(result).toMatchObject({ filled: [], missingEdited: 0, missingUnavailable: 2 });
  });
});
