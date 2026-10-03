import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, parseLearningItem } from "@pebble/schema";
import { testEpisode, testTranscript } from "../../test/fixtures.tsx";
import { buildLearningItem } from "./buildLearningItem.ts";

const segment = testTranscript.segments[2]!;
const now = new Date("2026-10-03T10:00:00Z");

describe("buildLearningItem", () => {
  it("snapshots an unedited segment as a valid learning item", () => {
    const item = buildLearningItem({
      episode: testEpisode,
      transcript: testTranscript,
      segment,
      correction: null,
      pinyin: "dì sān jù。",
      translation: "The third sentence.",
      id: "id-1",
      now,
    });
    expect(parseLearningItem(item).ok).toBe(true);
    expect(item).toMatchObject({
      text: "第三句。",
      originalText: null,
      savedAt: "2026-10-03T10:00:00.000Z",
      provenance: { corrected: false, audioKind: "tts-placeholder", transcriptKind: "fixture" },
    });
  });

  it("uses the corrected text and records the original", () => {
    const item = buildLearningItem({
      episode: testEpisode,
      transcript: testTranscript,
      segment,
      correction: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        episodeId: testEpisode.id,
        segmentId: segment.id,
        originalText: segment.text,
        correctedText: "第三句话。",
        updatedAt: now.toISOString(),
      },
      pinyin: null,
      translation: null,
      now,
    });
    expect(parseLearningItem(item).ok).toBe(true);
    expect(item).toMatchObject({
      text: "第三句话。",
      originalText: "第三句。",
      provenance: { corrected: true },
    });
  });
});
