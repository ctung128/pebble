import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { testEpisode, testTranscript } from "../../test/fixtures.tsx";
import { buildLearningItem } from "./buildLearningItem.ts";
import { LearningProvider, useLearning } from "./LearningContext.tsx";
import { MemoryLearningStore } from "./MemoryLearningStore.ts";

describe("LearningProvider", () => {
  it("refuses to save learning items from mock transcripts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new MemoryLearningStore();
    let learning!: ReturnType<typeof useLearning>;
    function Probe() {
      learning = useLearning();
      return null;
    }
    render(
      <LearningProvider openStore={() => Promise.resolve(store)}>
        <Probe />
      </LearningProvider>,
    );
    await act(async () => {});
    const mock = buildLearningItem({
      episode: testEpisode,
      transcript: { ...testTranscript, provenance: { ...testTranscript.provenance, kind: "mock" } },
      segment: testTranscript.segments[0]!,
      correction: null,
      pinyin: null,
      translation: null,
    });
    act(() => learning.saveItem(mock));
    expect(learning.items).toEqual([]);
    expect(await store.listItems()).toEqual([]);
    warn.mockRestore();
  });

  describe("playback positions", () => {
    const position = {
      episodeId: "ep-0123456789ab",
      positionMs: 60_000,
      durationMs: 768_000,
      updatedAt: "2026-10-05T12:00:00.000Z",
      finishedAt: null,
    };

    async function setup(store = new MemoryLearningStore()) {
      let learning!: ReturnType<typeof useLearning>;
      function Probe() {
        learning = useLearning();
        return null;
      }
      render(
        <LearningProvider openStore={() => Promise.resolve(store)}>
          <Probe />
        </LearningProvider>,
      );
      await act(async () => {});
      return { store, learning: () => learning };
    }

    it("saves, reads back and clears a position", async () => {
      const { store, learning } = await setup();
      act(() => learning().savePlayback(position));
      expect(learning().playbackFor("ep-0123456789ab")).toEqual(position);
      expect(await store.listPlayback()).toEqual([position]);
      act(() => learning().clearPlayback("ep-0123456789ab"));
      expect(learning().playbackFor("ep-0123456789ab")).toBeNull();
      expect(await store.listPlayback()).toEqual([]);
    });

    it("loads stored positions on start", async () => {
      const store = new MemoryLearningStore();
      await store.putPlayback(position);
      const { learning } = await setup(store);
      expect(learning().playbackFor("ep-0123456789ab")).toEqual(position);
    });

    it("drops an episode's position when its source is deleted, and all on reset", async () => {
      const { store, learning } = await setup();
      act(() => learning().savePlayback(position));
      act(() => learning().savePlayback({ ...position, episodeId: "ep-bbbbbbbbbbbb" }));
      act(() => learning().markSourceDeleted("ep-0123456789ab"));
      expect(learning().playbackFor("ep-0123456789ab")).toBeNull();
      expect(learning().playbackFor("ep-bbbbbbbbbbbb")).not.toBeNull();
      act(() => learning().resetAll());
      expect(learning().playback.size).toBe(0);
      await act(async () => {});
      expect(await store.listPlayback()).toEqual([]);
    });

    it("keeps working for the session when a write fails", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const store = new MemoryLearningStore();
      store.putPlayback = () => Promise.reject(new Error("quota"));
      const { learning } = await setup(store);
      act(() => learning().savePlayback(position));
      await act(async () => {});
      expect(learning().persistence).toEqual({ mode: "session", reason: "write-failed" });
      expect(learning().playbackFor("ep-0123456789ab")).toEqual(position);
      warn.mockRestore();
    });
  });
});
