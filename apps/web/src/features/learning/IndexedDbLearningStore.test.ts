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

  it("deletes every correction of one episode and nothing else", async () => {
    const store = await IndexedDbLearningStore.open(new IDBFactory(), "range");
    const of = (episodeId: string, segmentId: string) => ({ ...correction, episodeId, segmentId });
    for (const c of [
      of("ep-aaaaaaaaaaaa", "seg-1"),
      of("ep-aaaaaaaaaaaa", "seg-2"),
      of("ep-aaaaaaaaaaab", "seg-1"),
      of("test-001", "seg-1"),
    ]) {
      await store.putCorrection(c);
    }
    await store.deleteCorrectionsForEpisode("ep-aaaaaaaaaaaa");
    const left = (await store.listCorrections()).map((c) => `${c.episodeId}/${c.segmentId}`);
    expect(left.sort()).toEqual(["ep-aaaaaaaaaaab/seg-1", "test-001/seg-1"]);
    store.close();
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

  it("upgrades a version 1 database, keeping corrections and items", async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const request = factory.open("pebble", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("corrections", { keyPath: ["episodeId", "segmentId"] }).put(
          correction,
        );
        db.createObjectStore("items", { keyPath: "id" }).put(item);
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });

    const store = await IndexedDbLearningStore.open(factory);
    expect(await store.listCorrections()).toEqual([correction]);
    expect(await store.listItems()).toEqual([item]);
    expect(await store.listPlayback()).toEqual([]);
  });

  it("stores playback positions by episode, and nothing but their five fields", async () => {
    const factory = new IDBFactory();
    const store = await IndexedDbLearningStore.open(factory);
    const position = {
      episodeId: "ep-0123456789ab",
      positionMs: 60_000,
      durationMs: 768_000,
      updatedAt: "2026-10-05T12:00:00.000Z",
      finishedAt: null,
    };
    // Even if a caller passes more, only the five fields are written.
    await store.putPlayback({ ...position, title: "Morning walk" } as typeof position);
    await store.putPlayback({ ...position, episodeId: "demo-001" });
    expect(await store.listPlayback()).toEqual(
      expect.arrayContaining([position, { ...position, episodeId: "demo-001" }]),
    );
    await store.deletePlayback("demo-001");
    expect(await store.listPlayback()).toEqual([position]);
    await store.clear();
    expect(await store.listPlayback()).toEqual([]);
  });

  it("skips playback rows that aren't valid records", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const factory = new IDBFactory();
    const store = await IndexedDbLearningStore.open(factory);
    store.close();
    await new Promise<void>((resolve, reject) => {
      const request = factory.open("pebble", 2);
      request.onsuccess = () => {
        const tx = request.result.transaction("playback", "readwrite");
        tx.objectStore("playback").put({ episodeId: "ep-0123456789ab", positionMs: -5 });
        tx.oncomplete = () => {
          request.result.close();
          resolve();
        };
      };
      request.onerror = () => reject(request.error);
    });
    const reopened = await IndexedDbLearningStore.open(factory);
    expect(await reopened.listPlayback()).toEqual([]);
    expect(String(warn.mock.calls[0]?.[0])).not.toMatch(/ep-0123456789ab/); // no row data logged
    warn.mockRestore();
  });
});
