import { memo, type Ref } from "react";
import type { Segment } from "@pebble/schema";
import { StatusView } from "../../components/StatusView.tsx";
import { SegmentRow } from "./SegmentRow.tsx";
import styles from "./TranscriptReader.module.css";

interface TranscriptReaderProps {
  segments: readonly Segment[];
  /** From findActiveSegmentIndex; -1 when nothing is active yet. */
  activeIndex: number;
  language: string;
  /** Click/tap on a line. The parent decides what that means (seek + play). */
  onSelectSegment: (segment: Segment) => void;
  ref?: Ref<HTMLOListElement>;
}

/**
 * Presentational, fully controlled transcript. It never touches audio or fetches data,
 * so it renders identically for demo fixtures and (later) worker transcripts.
 */
export const TranscriptReader = memo(function TranscriptReader({
  segments,
  activeIndex,
  language,
  onSelectSegment,
  ref,
}: TranscriptReaderProps) {
  if (segments.length === 0) {
    return (
      <StatusView kind="empty" title="No transcript lines" message="This transcript is empty." />
    );
  }

  return (
    <ol ref={ref} className={styles.list} aria-label="Transcript">
      {segments.map((segment, i) => (
        <li key={segment.id} data-segment-index={i}>
          <SegmentRow
            segment={segment}
            state={i === activeIndex ? "active" : i < activeIndex ? "past" : "upcoming"}
            showSpeaker={segment.speaker !== segments[i - 1]?.speaker}
            language={language}
            onSelect={onSelectSegment}
          />
        </li>
      ))}
    </ol>
  );
});
