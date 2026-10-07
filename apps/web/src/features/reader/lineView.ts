import type { Correction, Segment } from "@pebble/schema";
import type { CorrectionResult } from "../learning/LearningContext.tsx";
import type { LineTranslation } from "../translation/useLineTranslations.ts";

/** Everything a transcript row displays besides the segment itself. */
export interface LineView {
  /** Displayed Chinese text: the learner's correction if there is one. */
  text: string;
  correction: Correction | null;
  showOriginal: boolean;
  needsReview: boolean;
  pinyin:
    | { visible: false }
    | { visible: true; status: "loading" | "ready" | "error"; text: string | null };
  translation: LineTranslation | undefined;
  /** Hide this line's English action (local English isn't set up and the line has none). */
  translationHidden?: boolean;
  saved: boolean;
  confirmingUnsave: boolean;
  editing: boolean;
}

/** Row callbacks. Stable for the lifetime of an episode view so rows can stay memoized. */
export interface LineActions {
  select: (segment: Segment) => void;
  togglePinyin: (segment: Segment) => void;
  retryPinyin: () => void;
  toggleTranslation: (segment: Segment) => void;
  retryTranslation: (segment: Segment) => void;
  toggleSave: (segment: Segment) => void;
  confirmUnsave: (segment: Segment) => void;
  cancelUnsave: () => void;
  startEdit: (segment: Segment) => void;
  cancelEdit: () => void;
  saveEdit: (segment: Segment, text: string) => CorrectionResult;
  revert: (segment: Segment) => void;
  toggleOriginal: (segment: Segment) => void;
}
