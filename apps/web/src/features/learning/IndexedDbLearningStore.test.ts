import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { CURRENT_SCHEMA_VERSION, type Correction } from "@pebble/schema";
import { testEpisode, testTranscript } from "../../test/fixtures.tsx";
import { buildLearningItem } from "./buildLearningItem.ts";
import { IndexedDbLearningStore } from "./IndexedDbLearningStore.ts";

const correction: Correction = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  episodeId: "test-001",
  segmentId: "seg-1",
  originalText: "第一句。",
  correctedText: "第一句话。",
  updatedAt: "2026-10-03T00:00:00Z",
};

const item = buildLearningItem({
  episode: testEpisode,
  transcript: testTranscript,
  segment: testTranscript.segments[0]!,
  correction: null,
  pinyin: null,
  translation: null,
  id: "item-1",
});

describe("IndexedDbLearningStore", () => {
  it("persists corrections and items across connections", async () => {
    const factory = new IDBFactory();
    const first = await IndexedDbLearningStore.open(factory);
    await first.putCorrection(correction);
    await first.putItem(item);
    first.close();

    const second = await IndexedDbLearningStore.open(factory);
    expect(await second.listCorrections()).toEqual([correction]);
    expect(await second.listItems()).toEqual([item]);
  });

  it("replaces a correction for the same segment and deletes by key", async () => {
    const store = await IndexedDbLearningStore.open(new IDBFactory());
    await store.putCorrection(correction);
    await store.putCorrection({ ...correction, correctedText: "第一句话呀。" });
    expect(await store.listCorrections()).toHaveLength(1);
    await store.deleteCorrection("test-001", "seg-1");
    expect(await store.listCorrections()).toEqual([]);
  });

  it("deletes items and clears everything", async () => {
    const store = await IndexedDbLearningStore.open(new IDBFactory());
    await store.putItem(item);
    await store.putItem({ ...item, id: "item-2" });
    await store.deleteItem("item-1");
    expect((await store.listItems()).map((i) => i.id)).toEqual(["item-2"]);
    await store.putCorrection(correction);
    await store.clear();
    expect(await store.listItems()).toEqual([]);
    expect(await store.listCorrections()).toEqual([]);
  });

  it("skips stored rows that no longer match the contract", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const factory = new IDBFactory();
    const store = await IndexedDbLearningStore.open(factory);
    await store.putItem(item);
    // Simulate a row written by an incompatible version.
    await store.putItem({ ...item, id: "broken", text: "" } as never);
    expect((await store.listItems()).map((i) => i.id)).toEqual(["item-1"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("rejects when IndexedDB is unavailable", async () => {
    await expect(IndexedDbLearningStore.open(undefined)).rejects.toThrow(/not available/);
  });
});
