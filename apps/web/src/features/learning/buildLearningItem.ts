import {
  CURRENT_SCHEMA_VERSION,
  type Correction,
  type Episode,
  type LearningItem,
  type Segment,
  type Transcript,
} from "@pebble/schema";

interface BuildLearningItemInput {
  episode: Episode;
  transcript: Transcript;
  segment: Segment;
  correction: Correction | null;
  /** Generated pinyin for the displayed text, if pinyin has been generated this session. */
  pinyin: string | null;
  /** Translation of the displayed text, if one was resolved this session. */
  translation: string | null;
  id?: string;
  now?: Date;
}

/** Snapshots a transcript segment as a learning item, as the learner currently sees it. */
export function buildLearningItem({
  episode,
  transcript,
  segment,
  correction,
  pinyin,
  translation,
  id = crypto.randomUUID(),
  now = new Date(),
}: BuildLearningItemInput): LearningItem {
  const timestamp = now.toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id,
    kind: "segment",
    episodeId: episode.id,
    episodeTitle: episode.title,
    segmentId: segment.id,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: correction?.correctedText ?? segment.text,
    originalText: correction ? segment.text : null,
    pinyin,
    translation,
    note: null,
    savedAt: timestamp,
    updatedAt: timestamp,
    provenance: {
      transcriptKind: transcript.provenance.kind,
      transcriptProvider: transcript.provenance.provider,
      corrected: correction !== null,
      audioKind: episode.audioProvenance.kind,
    },
  };
}
