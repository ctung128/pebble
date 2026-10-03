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

/** Minimal RFC 4180 parser for verifying exported rows field by field. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

const dataRows = (csv: string) => parseCsv(csv).filter((row) => !row[0]?.startsWith("#"));

describe("toAnkiCsv column integrity", () => {
  it("keeps Translation as its own third column", () => {
    const [row] = dataRows(
      toAnkiCsv([item({ pinyin: "dì yī jù。", translation: "The first sentence.", note: "n" })]),
    );
    expect(row).toEqual([
      "第一句。",
      "dì yī jù。",
      "The first sentence.",
      "n",
      "Test episode · 0:00",
      "pebble pebble::test-001",
    ]);
  });

  it("leaves a missing translation blank without shifting later columns", () => {
    const [row] = dataRows(toAnkiCsv([item({ pinyin: "dì yī jù。", note: "Remember this" })]));
    expect(row).toHaveLength(6);
    expect(row![2]).toBe("");
    expect(row![3]).toBe("Remember this");
    expect(row![4]).toBe("Test episode · 0:00");
  });

  it("round-trips commas, quotes and multiline notes into the right columns", () => {
    const tricky = item({
      translation: 'Hello, "world"',
      note: "line one\nline two, with comma",
    });
    const [row] = dataRows(toAnkiCsv([tricky]));
    expect(row).toHaveLength(6);
    expect(row![2]).toBe('Hello, "world"');
    expect(row![3]).toBe("line one\nline two, with comma");
  });

  it("gives every row the same number of columns as the header declares", () => {
    const csv = toAnkiCsv([
      item({ id: "1" }),
      item({ id: "2", translation: "x, y", note: "a\nb" }),
      item({ id: "3", pinyin: "p" }),
    ]);
    const declared = csv.match(/^#columns:(.*)$/m)![1]!.split(",");
    expect(declared).toEqual(["Chinese", "Pinyin", "Translation", "Note", "Source", "Tags"]);
    for (const row of dataRows(csv)) expect(row).toHaveLength(declared.length);
  });

  it("declares a comma separator, plain text and the tags column, with no note type", () => {
    const header = toAnkiCsv([]).trimEnd().split("\n");
    expect(header).toContain("#separator:Comma");
    expect(header).toContain("#html:false");
    expect(header).toContain("#tags column:6");
    expect(header.some((line) => line.startsWith("#notetype"))).toBe(false);
  });

  it("encodes Chinese text as UTF-8 that decodes unchanged", () => {
    const csv = toAnkiCsv([item({ translation: "One, “quoted”" })]);
    const bytes = new TextEncoder().encode(csv);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBe(csv);
    expect(bytes.slice(0, 3)).not.toEqual(new Uint8Array([0xef, 0xbb, 0xbf])); // no BOM
  });
});

describe("mock content", () => {
  it("is never exported", () => {
    const mock = item({
      text: "（模拟转写）第 1-1 段",
      provenance: { ...item().provenance, transcriptKind: "mock" },
    });
    const csv = toAnkiCsv([mock, item({ id: "real" })]);
    expect(csv).not.toContain("模拟转写");
    expect(csv).toContain("第一句。");
  });
});
