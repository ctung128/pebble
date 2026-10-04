import type { Correction, LearningItem } from "@pebble/schema";
import { correctionKey, type LearningStore } from "./LearningStore.ts";

/** Non-persistent store for tests. */
export class MemoryLearningStore implements LearningStore {
  private readonly corrections = new Map<string, Correction>();
  private readonly items = new Map<string, LearningItem>();

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

  async clear() {
    this.corrections.clear();
    this.items.clear();
  }
}
