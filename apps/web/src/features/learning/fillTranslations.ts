import type { LearningItem } from "@pebble/schema";
import { canRequestTranslation } from "../episode/transcriptCapabilities.ts";
import { TranslationError, type TranslationProvider } from "../translation/TranslationProvider.ts";

export interface FillTranslationsResult {
  /** All items, with translations filled in where one could be resolved. */
  items: LearningItem[];
  /** Items that gained a translation (to write back to the store). */
  filled: LearningItem[];
  /** Items still without English because their text was edited (no prepared translation). */
  missingEdited: number;
  /** Items still without English because the provider failed or had none. */
  missingUnavailable: number;
}

/**
 * Resolves English for items that don't have it yet, in parallel. Runs only on an explicit
 * export, so translations are still never requested in the background. Items from transcripts
 * without English (local speech recognition) are left as they are and never requested.
 */
export async function fillTranslations(
  items: readonly LearningItem[],
  provider: TranslationProvider,
  now = new Date(),
): Promise<FillTranslationsResult> {
  let missingEdited = 0;
  let missingUnavailable = 0;
  const filled: LearningItem[] = [];

  const results = await Promise.all(
    items.map(async (item) => {
      if (item.translation || !canRequestTranslation(item.provenance.transcriptKind)) return item;
      try {
        const translation = await provider.translate({
          episodeId: item.episodeId,
          segmentId: item.segmentId,
          text: item.text,
          sourceText: item.originalText ?? item.text,
        });
        const updated: LearningItem = {
          ...item,
          translation: translation.text,
          updatedAt: now.toISOString(),
        };
        filled.push(updated);
        return updated;
      } catch (error) {
        if (error instanceof TranslationError && error.code === "NOT_FOR_EDITED_TEXT") {
          missingEdited += 1;
        } else {
          missingUnavailable += 1;
        }
        return item;
      }
    }),
  );

  return { items: results, filled, missingEdited, missingUnavailable };
}
