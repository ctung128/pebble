import type { Correction, LearningItem } from "@pebble/schema";
import type { PlaybackRecord } from "./playback.ts";

/**
 * Browser-side persistence for learner data: corrections, learning items and listening
 * progress (playback positions). Kept small and
 * storage-agnostic so it can later be backed by (or migrated to) the local worker.
 */
export interface LearningStore {
  listCorrections(): Promise<Correction[]>;
  putCorrection(correction: Correction): Promise<void>;
  deleteCorrection(episodeId: string, segmentId: string): Promise<void>;
  /** Removes every correction for one episode (used when its source is deleted). */
  deleteCorrectionsForEpisode(episodeId: string): Promise<void>;
  listItems(): Promise<LearningItem[]>;
  putItem(item: LearningItem): Promise<void>;
  deleteItem(id: string): Promise<void>;
  /** Listening progress, one record per episode (browser-local; see playback.ts). */
  listPlayback(): Promise<PlaybackRecord[]>;
  putPlayback(record: PlaybackRecord): Promise<void>;
  deletePlayback(episodeId: string): Promise<void>;
  /** Removes all learner data. Never touches episode or transcript content. */
  clear(): Promise<void>;
}

export const correctionKey = (episodeId: string, segmentId: string) =>
  `${episodeId}\u0000${segmentId}`;
