import type { LearningItem } from "@pebble/schema";
import { formatTime } from "../../lib/formatTime.ts";

/**
 * Anki-compatible CSV (see docs/ANKI_EXPORT.md). Plain text only: `#html:false` tells Anki
 * not to interpret markup, so nothing in a field is treated as HTML.
 */
export const ANKI_COLUMNS = ["Chinese", "Pinyin", "Translation", "Note", "Source", "Tags"] as const;

const NEEDS_QUOTING = /[",\r\n]/;

/** RFC 4180 quoting; also quotes leading "#" (Anki header syntax) and edge whitespace. */
export function csvField(value: string): string {
  const quote = NEEDS_QUOTING.test(value) || value.startsWith("#") || value !== value.trim();
  return quote ? `"${value.replaceAll('"', '""')}"` : value;
}

export function itemSource(item: LearningItem): string {
  return `${item.episodeTitle} · ${formatTime(item.startMs)}`;
}

export function itemTags(item: LearningItem): string {
  const tags = ["pebble", `pebble::${item.episodeId}`];
  if (item.provenance.corrected) tags.push("pebble::edited");
  return tags.join(" ");
}

export function toAnkiCsv(items: readonly LearningItem[]): string {
  const header = [
    "#separator:Comma",
    "#html:false",
    `#columns:${ANKI_COLUMNS.join(",")}`,
    `#tags column:${ANKI_COLUMNS.indexOf("Tags") + 1}`,
  ];
  const rows = [...items]
    .sort((a, b) => a.savedAt.localeCompare(b.savedAt))
    .map((item) =>
      [
        item.text,
        item.pinyin ?? "",
        item.translation ?? "",
        item.note ?? "",
        itemSource(item),
        itemTags(item),
      ]
        .map(csvField)
        .join(","),
    );
  return `${[...header, ...rows].join("\n")}\n`;
}

export function ankiCsvFilename(now = new Date()): string {
  return `pebble-learning-items-${now.toISOString().slice(0, 10)}.csv`;
}
