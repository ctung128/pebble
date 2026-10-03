import { devFlags } from "../../devFlags.ts";
import { IndexedDbLearningStore } from "./IndexedDbLearningStore.ts";
import type { LearningStore } from "./LearningStore.ts";

/** Opens browser storage, or rejects so the app falls back to session-only data. */
export function openLearningStore(): Promise<LearningStore> {
  if (devFlags.sessionOnlyStorage) {
    return Promise.reject(new Error("Storage disabled by ?storage=session (development)."));
  }
  return IndexedDbLearningStore.open();
}
