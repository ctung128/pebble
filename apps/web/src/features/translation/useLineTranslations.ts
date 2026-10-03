import { useCallback, useState } from "react";
import type { Segment } from "@pebble/schema";
import { useTranslationProvider } from "./TranslationContext.tsx";
import { TranslationError } from "./TranslationProvider.ts";

export type LineTranslation =
  | { open: boolean; forText: string; status: "loading" }
  | { open: boolean; forText: string; status: "ready"; text: string }
  | { open: boolean; forText: string; status: "error"; message: string; retryable: boolean };

/**
 * Per-line, user-triggered translations for one episode view. Nothing is requested until a
 * learner opens a line's translation.
 */
export function useLineTranslations(episodeId: string) {
  const provider = useTranslationProvider();
  const [lines, setLines] = useState<ReadonlyMap<string, LineTranslation>>(new Map());

  const update = useCallback((segmentId: string, next: LineTranslation | null) => {
    setLines((current) => {
      const copy = new Map(current);
      if (next) copy.set(segmentId, next);
      else copy.delete(segmentId);
      return copy;
    });
  }, []);

  const request = useCallback(
    (segment: Segment, text: string) => {
      update(segment.id, { open: true, forText: text, status: "loading" });
      provider.translate({ episodeId, segmentId: segment.id, text, sourceText: segment.text }).then(
        (translation) =>
          update(segment.id, {
            open: true,
            forText: text,
            status: "ready",
            text: translation.text,
          }),
        (error: unknown) =>
          update(segment.id, {
            open: true,
            forText: text,
            status: "error",
            message:
              error instanceof TranslationError
                ? error.message
                : "Translation is unavailable right now. Try again, or keep listening.",
            retryable: !(error instanceof TranslationError) || error.retryable,
          }),
      );
    },
    [episodeId, provider, update],
  );

  /** Opens or closes a line's translation, requesting it on first open for this text. */
  const toggle = useCallback(
    (segment: Segment, text: string, current: LineTranslation | undefined) => {
      if (current?.open) {
        update(segment.id, { ...current, open: false });
      } else if (current && current.forText === text && current.status !== "error") {
        update(segment.id, { ...current, open: true });
      } else {
        request(segment, text);
      }
    },
    [request, update],
  );

  return { lines, toggle, retry: request };
}
