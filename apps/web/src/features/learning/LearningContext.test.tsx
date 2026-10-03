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
});
