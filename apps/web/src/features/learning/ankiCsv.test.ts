import { describe, expect, it } from "vitest";
import type { LearningItem } from "@pebble/schema";
import { testEpisode, testTranscript } from "../../test/fixtures.tsx";
import { ankiCsvFilename, csvField, toAnkiCsv } from "./ankiCsv.ts";
import { buildLearningItem } from "./buildLearningItem.ts";

function item(overrides: Partial<LearningItem> = {}): LearningItem {
  return {
    ...buildLearningItem({
      episode: testEpisode,
      transcript: testTranscript,
      segment: testTranscript.segments[0]!,
      correction: null,
      pinyin: null,
      translation: null,
      id: "item-1",
      now: new Date("2026-10-03T10:00:00Z"),
    }),
    ...overrides,
  };
}

const HEADER = [
  "#separator:Comma",
  "#html:false",
  "#columns:Chinese,Pinyin,Translation,Note,Source,Tags",
  "#tags column:6",
];

describe("csvField", () => {
  it.each([
    ["plain", "plain"],
    ["你好，世界", "你好，世界"], // full-width comma needs no quoting
    ["a,b", '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ["line 1\nline 2", '"line 1\nline 2"'],
    ["#hashtag", '"#hashtag"'],
    [" padded ", '" padded "'],
    ["", ""],
  ])("%j → %j", (value, expected) => {
    expect(csvField(value)).toBe(expected);
  });
});

describe("toAnkiCsv", () => {
  it("writes the Anki header and one row per item", () => {
    const csv = toAnkiCsv([
      item({ pinyin: "dì yī jù。", translation: "The first sentence.", note: "Easy one" }),
    ]);
    expect(csv.split("\n")).toEqual([
      ...HEADER,
      "第一句。,dì yī jù。,The first sentence.,Easy one,Test episode · 0:00,pebble pebble::test-001",
      "",
    ]);
  });

  it("leaves missing optional fields empty", () => {
    const [, , , , row] = toAnkiCsv([item()]).split("\n");
    expect(row).toBe("第一句。,,,,Test episode · 0:00,pebble pebble::test-001");
  });

  it("escapes commas, quotes and multiline notes", () => {
    const csv = toAnkiCsv([
      item({ translation: 'Hello, "world"', note: "line one\nline two, with comma" }),
    ]);
    expect(csv).toContain(
      '第一句。,,"Hello, ""world""","line one\nline two, with comma",Test episode · 0:00,',
    );
  });

  it("tags edited items and keeps the corrected Chinese text", () => {
    const csv = toAnkiCsv([
      item({
        text: "第一句话。",
        originalText: "第一句。",
        provenance: { ...item().provenance, corrected: true },
      }),
    ]);
    expect(csv).toContain(
      "第一句话。,,,,Test episode · 0:00,pebble pebble::test-001 pebble::edited",
    );
  });

  it("orders rows by save time", () => {
    const csv = toAnkiCsv([
      item({ id: "b", text: "后来。", savedAt: "2026-10-03T12:00:00Z" }),
      item({ id: "a", text: "先。", savedAt: "2026-10-03T11:00:00Z" }),
    ]);
    const rows = csv.split("\n").slice(HEADER.length, -1);
    expect(rows.map((r) => r.split(",")[0])).toEqual(["先。", "后来。"]);
  });

  it("writes only the header for no items", () => {
    expect(toAnkiCsv([])).toBe(`${HEADER.join("\n")}\n`);
  });

  it("names the file by date", () => {
    expect(ankiCsvFilename(new Date("2026-10-03T23:00:00Z"))).toBe(
      "pebble-learning-items-2026-10-03.csv",
    );
  });
});
