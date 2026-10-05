import type { Correction, LearningItem } from "@pebble/schema";
import { correctionKey, type LearningStore } from "./LearningStore.ts";
import type { PlaybackRecord } from "./playback.ts";

/** Non-persistent store for tests. */
export class MemoryLearningStore implements LearningStore {
  private readonly corrections = new Map<string, Correction>();
  private readonly items = new Map<string, LearningItem>();
  private readonly playback = new Map<string, PlaybackRecord>();

  async listCorrections() {
    return [...this.corrections.values()];
  }

  async putCorrection(correction: Correction) {
    this.corrections.set(correctionKey(correction.episodeId, correction.segmentId), correction);
  }

  async deleteCorrection(episodeId: string, segmentId: string) {
    this.corrections.delete(correctionKey(episodeId, segmentId));
  }

  async deleteCorrectionsForEpisode(episodeId: string) {
    for (const [key, correction] of this.corrections) {
      if (correction.episodeId === episodeId) this.corrections.delete(key);
    }
  }

  async listItems() {
    return [...this.items.values()];
  }

  async putItem(item: LearningItem) {
    this.items.set(item.id, item);
  }

  async deleteItem(id: string) {
    this.items.delete(id);
  }

  async listPlayback() {
    return [...this.playback.values()];
  }

  async putPlayback(record: PlaybackRecord) {
    this.playback.set(record.episodeId, record);
  }

  async deletePlayback(episodeId: string) {
    this.playback.delete(episodeId);
  }

  async clear() {
    this.corrections.clear();
    this.items.clear();
    this.playback.clear();
  }
}
