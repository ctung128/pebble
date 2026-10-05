import type { TranscriptProvenance } from "@pebble/schema";

/**
 * What a learner may do with a transcript, decided only by where it came from.
 *
 * - `fixture` (authorized demo content): every tool, with prepared demo translations.
 * - `asr` (local speech recognition): every learning tool except English, which stays hidden
 *   until a real local translation provider exists. Nothing may request a translation.
 * - `mock` (placeholder pipeline output): learning tools are visible but locked, and the text
 *   never becomes a learning item.
 */
export interface TranscriptCapabilities {
  /** Pinyin, saving learning items, editing lines. */
  learning: boolean;
  /** "available": shown and usable; "locked": shown but disabled; "hidden": not shown at all. */
  translation: "available" | "locked" | "hidden";
  /** "Copy Chinese": a local clipboard action, independent of translation. */
  copy: boolean;
}

export function transcriptCapabilities(kind: TranscriptProvenance["kind"]): TranscriptCapabilities {
  switch (kind) {
    case "fixture":
      return { learning: true, translation: "available", copy: true };
    case "asr":
      return { learning: true, translation: "hidden", copy: true };
    case "mock":
      return { learning: false, translation: "locked", copy: false }; // placeholder text
  }
}

/** Whether a translation may ever be requested for content of this kind. */
export function canRequestTranslation(kind: TranscriptProvenance["kind"]): boolean {
  return transcriptCapabilities(kind).translation === "available";
}

/**
 * What "About this transcript" (the i button) says. One fact, once: a local machine transcript
 * covers its pinyin too; otherwise only the pinyin is generated. Names no model or provider.
 */
export const ABOUT_MACHINE_TRANSCRIPT =
  "This transcript and its pinyin were generated automatically and may need review.";
export const ABOUT_PINYIN =
  "Pronunciation is generated automatically and may be imperfect for some words.";
