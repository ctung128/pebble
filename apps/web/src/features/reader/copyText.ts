import { useCallback, useEffect, useRef, useState } from "react";
import { speakerLabel } from "./speaker.ts";

export type CopyStatus = "idle" | "copied" | "failed";

/** How long "Copied" shows before the action returns to normal. */
export const COPY_RESET_MS = 2000;
export const COPY_LABEL = "Copy Chinese text for this line";
export const COPY_HELP =
  "Copies this line's Chinese text to your clipboard. Pasting it into another service may send it there.";
export const COPY_FAILED = "Couldn't copy. Select the text and copy it manually.";

export const COPY_TRANSCRIPT_LABEL = "Copy transcript";
export const COPY_TRANSCRIPT_DONE = "Transcript copied";
export const COPY_TRANSCRIPT_HELP =
  "Copies the Chinese transcript as plain text. Pasting it into another service may send it there.";

/**
 * The whole transcript as plain text: each line's displayed Chinese (the learner's correction
 * where there is one), in reading order, one line per transcript line, joined by newlines.
 * A line with a speaker label in the transcript starts "Speaker A: ", repeated on every such
 * line so each one stands on its own when pasted; lines without one stay Chinese only.
 * Never the title, IDs, times, pinyin, English or notes.
 */
export function transcriptPlainText(
  segments: readonly { id: string; text: string; speaker?: string | null }[],
  displayedText: (segmentId: string) => string | undefined,
): string {
  return segments
    .map((segment) => {
      const text = displayedText(segment.id) ?? segment.text;
      return segment.speaker ? `${speakerLabel(segment.speaker)}: ${text}` : text;
    })
    .join("\n");
}

/**
 * Copies one line's displayed text to the clipboard on an explicit tap. A local browser
 * action only: no network, storage, logging or clipboard reads. `copy` must be called
 * directly from the click handler so the browser sees the user's gesture.
 */
export function useCopyText() {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback((text: string) => {
    window.clearTimeout(timer.current);
    let pending: Promise<void>;
    try {
      pending = navigator.clipboard.writeText(text); // throws if the Clipboard API is missing
    } catch {
      pending = Promise.reject(new Error("clipboard unavailable"));
    }
    pending.then(
      () => {
        if (!mounted.current) return;
        setStatus("copied");
        timer.current = window.setTimeout(() => {
          if (mounted.current) setStatus("idle");
        }, COPY_RESET_MS);
      },
      () => {
        if (mounted.current) setStatus("failed"); // never logged: the text must not reach logs
      },
    );
  }, []);

  const dismiss = useCallback(() => setStatus("idle"), []);

  return { status, copy, dismiss };
}
