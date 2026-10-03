import { memo } from "react";
import type { Segment } from "@pebble/schema";
import { formatTime } from "../../lib/formatTime.ts";
import styles from "./TranscriptReader.module.css";

interface SegmentRowProps {
  segment: Segment;
  state: "past" | "active" | "upcoming";
  showSpeaker: boolean;
  language: string;
  onSelect: (segment: Segment) => void;
}

export const SegmentRow = memo(function SegmentRow({
  segment,
  state,
  showSpeaker,
  language,
  onSelect,
}: SegmentRowProps) {
  return (
    <button
      type="button"
      className={styles.row}
      data-state={state}
      aria-current={state === "active" ? "true" : undefined}
      onClick={() => onSelect(segment)}
    >
      <span className={styles.meta}>
        <span className={styles.time}>{formatTime(segment.startMs)}</span>
        {showSpeaker && segment.speaker ? (
          <span className={styles.speaker} aria-label={`Speaker ${segment.speaker}`}>
            {segment.speaker}
          </span>
        ) : null}
      </span>
      <span className={styles.text} lang={language}>
        {segment.text}
      </span>
    </button>
  );
});
