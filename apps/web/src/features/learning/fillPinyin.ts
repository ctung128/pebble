import type { LearningItem } from "@pebble/schema";
import { loadPinyin, type PinyinConverter } from "../pinyin/loadPinyin.ts";

export interface FillPinyinResult {
  items: LearningItem[];
  /** Items that gained pinyin (to write back to the store). */
  filled: LearningItem[];
  /** True when the pinyin module couldn't load, so missing pinyin stayed blank. */
  failed: boolean;
}

/**
 * Generates pinyin for items saved without it. Runs locally (no network beyond loading the
 * pinyin module once) and only on an explicit export. Works for edited lines too, since
 * pinyin is generated from the saved text.
 */
export async function fillPinyin(
  items: readonly LearningItem[],
  load: () => Promise<PinyinConverter> = loadPinyin,
  now = new Date(),
): Promise<FillPinyinResult> {
  if (items.every((item) => item.pinyin)) return { items: [...items], filled: [], failed: false };

  let convert: PinyinConverter;
  try {
    convert = await load();
  } catch (error) {
    console.warn("Pebble: pinyin unavailable during export.", error);
    return { items: [...items], filled: [], failed: true };
  }

  const filled: LearningItem[] = [];
  const result = items.map((item) => {
    if (item.pinyin) return item;
    const pinyin = convert(item.text);
    if (!pinyin) return item;
    const updated: LearningItem = { ...item, pinyin, updatedAt: now.toISOString() };
    filled.push(updated);
    return updated;
  });
  return { items: result, filled, failed: false };
}
