import {
  parseCorrection,
  parseLearningItem,
  type Correction,
  type LearningItem,
  type ParseResult,
} from "@pebble/schema";
import type { LearningStore } from "./LearningStore.ts";

const DB_NAME = "pebble";
const DB_VERSION = 1;
const CORRECTIONS = "corrections";
const ITEMS = "items";

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Transaction aborted"));
  });
}

/** Keeps valid rows and skips (but reports) rows written by an incompatible version. */
function validRows<T>(
  rows: unknown[],
  parse: (row: unknown) => ParseResult<T>,
  label: string,
): T[] {
  const valid: T[] = [];
  for (const row of rows) {
    const result = parse(row);
    if (result.ok) valid.push(result.data);
    else console.warn(`Pebble: skipped an unreadable stored ${label}.`, result.issues);
  }
  return valid;
}

export class IndexedDbLearningStore implements LearningStore {
  private readonly db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  /** Rejects when IndexedDB is missing or blocked (e.g. some private browsing modes). */
  static open(factory: IDBFactory | undefined = globalThis.indexedDB, name = DB_NAME) {
    return new Promise<IndexedDbLearningStore>((resolve, reject) => {
      if (!factory) {
        reject(new Error("IndexedDB is not available in this browser."));
        return;
      }
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(name, DB_VERSION);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CORRECTIONS)) {
          db.createObjectStore(CORRECTIONS, { keyPath: ["episodeId", "segmentId"] });
        }
        if (!db.objectStoreNames.contains(ITEMS)) {
          db.createObjectStore(ITEMS, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(new IndexedDbLearningStore(request.result));
      request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB."));
      request.onblocked = () => reject(new Error("IndexedDB is blocked by another tab."));
    });
  }

  async listCorrections(): Promise<Correction[]> {
    const rows = await settle(this.db.transaction(CORRECTIONS).objectStore(CORRECTIONS).getAll());
    return validRows(rows, parseCorrection, "correction");
  }

  putCorrection(correction: Correction) {
    return this.write(CORRECTIONS, (store) => store.put(correction));
  }

  deleteCorrection(episodeId: string, segmentId: string) {
    return this.write(CORRECTIONS, (store) => store.delete([episodeId, segmentId]));
  }

  deleteCorrectionsForEpisode(episodeId: string) {
    // One transaction: read the [episodeId, segmentId] keys, delete that episode's.
    return this.write(CORRECTIONS, (store) => {
      const keys = store.getAllKeys();
      keys.onsuccess = () => {
        for (const key of keys.result) {
          if (Array.isArray(key) && key[0] === episodeId) store.delete(key);
        }
      };
    });
  }

  async listItems(): Promise<LearningItem[]> {
    const rows = await settle(this.db.transaction(ITEMS).objectStore(ITEMS).getAll());
    return validRows(rows, parseLearningItem, "learning item");
  }

  putItem(item: LearningItem) {
    return this.write(ITEMS, (store) => store.put(item));
  }

  deleteItem(id: string) {
    return this.write(ITEMS, (store) => store.delete(id));
  }

  clear() {
    const transaction = this.db.transaction([CORRECTIONS, ITEMS], "readwrite");
    transaction.objectStore(CORRECTIONS).clear();
    transaction.objectStore(ITEMS).clear();
    return done(transaction);
  }

  close() {
    this.db.close();
  }

  private write(storeName: string, operation: (store: IDBObjectStore) => void) {
    const transaction = this.db.transaction(storeName, "readwrite");
    operation(transaction.objectStore(storeName));
    return done(transaction);
  }
}
