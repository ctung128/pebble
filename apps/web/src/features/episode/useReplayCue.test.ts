import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useReplayCue } from "./useReplayCue.ts";

const SEGMENTS = [
  { id: "seg-1", startMs: 0 },
  { id: "seg-2", startMs: 3000 },
];

function setup(episodeId = "ep-a", currentTimeMs = 2800) {
  const audio = document.createElement("audio");
  const ref = { current: audio };
  const view = renderHook(
    (props: { episodeId: string; currentTimeMs: number }) =>
      useReplayCue(ref, SEGMENTS, props.episodeId, props.currentTimeMs),
    { initialProps: { episodeId, currentTimeMs } },
  );
  return { ...view, audio };
}

describe("useReplayCue", () => {
  it("holds the cued line only during its pre-roll", () => {
    const { result, rerender } = setup();
    act(() => void result.current.start(SEGMENTS[1]!, 2800));
    expect(result.current.cuedIndex).toBe(1);
    rerender({ episodeId: "ep-a", currentTimeMs: 3000 }); // reached the line
    expect(result.current.cuedIndex).toBeNull();
  });

  it("is ignored once the episode changes", () => {
    const { result, rerender } = setup();
    act(() => void result.current.start(SEGMENTS[1]!, 2800));
    rerender({ episodeId: "ep-b", currentTimeMs: 2800 });
    expect(result.current.cuedIndex).toBeNull();
  });

  it("drops only its own cue when playback fails to start", () => {
    const { result } = setup();
    let first = 0;
    act(() => void (first = result.current.start(SEGMENTS[1]!, 2800)));
    act(() => void result.current.start(SEGMENTS[1]!, 2800)); // a newer replay
    act(() => result.current.fail(first));
    expect(result.current.cuedIndex).toBe(1);
  });

  it("ignores its own seek but drops the cue on any other", () => {
    const { result, audio } = setup();
    let now = 2.8;
    Object.defineProperty(audio, "currentTime", { configurable: true, get: () => now });
    act(() => void result.current.start(SEGMENTS[1]!, 2800));
    act(() => void audio.dispatchEvent(new Event("seeking")));
    expect(result.current.cuedIndex).toBe(1);
    now = 1;
    act(() => void audio.dispatchEvent(new Event("seeking")));
    expect(result.current.cuedIndex).toBeNull();
  });

  it.each(["pause", "ended", "error", "emptied"])("drops the cue on %s", (type) => {
    const { result, audio } = setup();
    act(() => void result.current.start(SEGMENTS[1]!, 2800));
    act(() => void audio.dispatchEvent(new Event(type)));
    expect(result.current.cuedIndex).toBeNull();
  });
});
