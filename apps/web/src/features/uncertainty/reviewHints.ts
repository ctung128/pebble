import type { Segment } from "@pebble/schema";
import type { ReviewHint } from "../../data/EpisodeSource.ts";

/**
 * Below this provider-reported confidence a line is marked "May need review". Only applies
 * to real provider confidence; M0B fixtures have none (confidence is null).
 */
export const PROVIDER_REVIEW_THRESHOLD = 0.6;

/** Segment id → where the review flag came from. Provider signals take precedence. */
export function deriveReviewHints(
  segments: readonly Segment[],
  hints: readonly ReviewHint[],
): Map<string, ReviewHint["source"]> {
  const flagged = new Map<string, ReviewHint["source"]>();
  const known = new Set(segments.map((s) => s.id));
  for (const hint of hints) {
    if (known.has(hint.segmentId)) flagged.set(hint.segmentId, hint.source);
  }
  for (const segment of segments) {
    if (segment.confidence !== null && segment.confidence < PROVIDER_REVIEW_THRESHOLD) {
      flagged.set(segment.id, "provider");
    }
  }
  return flagged;
}
