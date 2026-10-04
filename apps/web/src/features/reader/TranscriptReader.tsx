import { memo, type Ref } from "react";
import type { Segment } from "@pebble/schema";
import { StatusView } from "../../components/StatusView.tsx";
import type { LineActions, LineView } from "./lineView.ts";
import { SegmentRow } from "./SegmentRow.tsx";
import styles from "./TranscriptReader.module.css";

interface TranscriptReaderProps {
  segments: readonly Segment[];
  /** From findActiveSegmentIndex; -1 when nothing is active yet. */
  activeIndex: number;
  language: string;
  /** Per-segment display state, keyed by segment id. */
  lines: ReadonlyMap<string, LineView>;
  actions: LineActions;
  /** Id of the element explaining "May need review". */
  reviewDescriptionId: string;
  /** When set, learning actions are disabled and described by this element. */
  lockedDescriptionId?: string | undefined;
  /** False removes the English action entirely (no translation exists for this transcript). */
  showTranslation?: boolean;
  /** Shows the "Copy Chinese" action (a local clipboard copy of the displayed line). */
  showCopy?: boolean;
  ref?: Ref<HTMLOListElement>;
}

/**
 * Presentational, fully controlled transcript. It never touches audio, storage or the
 * network, so it renders identically for demo fixtures and (later) worker transcripts.
 */
export const TranscriptReader = memo(function TranscriptReader({
  segments,
  activeIndex,
  language,
  lines,
  actions,
  reviewDescriptionId,
  lockedDescriptionId,
  showTranslation = true,
  showCopy = false,
  ref,
}: TranscriptReaderProps) {
  if (segments.length === 0) {
    return (
      <StatusView kind="empty" title="No transcript lines" message="This transcript is empty." />
    );
  }

  return (
    <ol ref={ref} className={styles.list} aria-label="Transcript">
      {segments.map((segment, i) => {
        const view = lines.get(segment.id);
        if (!view) return null;
        return (
          <li key={segment.id} data-segment-index={i}>
            <SegmentRow
              segment={segment}
              state={i === activeIndex ? "active" : i < activeIndex ? "past" : "upcoming"}
              showSpeaker={segment.speaker !== segments[i - 1]?.speaker}
              language={language}
              view={view}
              actions={actions}
              reviewDescriptionId={reviewDescriptionId}
              lockedDescriptionId={lockedDescriptionId}
              showTranslation={showTranslation}
              showCopy={showCopy}
            />
          </li>
        );
      })}
    </ol>
  );
});

/** A LineView for a segment with no learner state — for tests and simple callers. */
export function plainLineView(segment: Segment): LineView {
  return {
    text: segment.text,
    correction: null,
    showOriginal: false,
    needsReview: false,
    pinyin: { visible: false },
    translation: undefined,
    saved: false,
    confirmingUnsave: false,
    editing: false,
  };
}
