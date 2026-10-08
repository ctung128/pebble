/**
 * Listening position: saved conservatively and restored (paused) on arrival, in the demo and
 * in local mode alike. Invented content.
 */
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test/fixtures.tsx";
import { MemoryLearningStore } from "../learning/MemoryLearningStore.ts";
import type { PlaybackRecord } from "../learning/playback.ts";
import { EpisodePage } from "./EpisodePage.tsx";
import { SAVE_INTERVAL_MS } from "./usePlaybackProgress.ts";

const EPISODE = "test-001"; // 9 s long in the fixtures

let now = 0; // the audio's currentTime, in seconds

function controlAudio(audio: HTMLAudioElement) {
  Object.defineProperty(audio, "currentTime", {
    configurable: true,
    get: () => now,
    set: (value: number) => (now = value),
  });
  Object.defineProperty(audio, "duration", { configurable: true, get: () => 9 });
}

async function renderEpisode(store = new MemoryLearningStore(), route = "/") {
  const put = vi.spyOn(store, "putPlayback");
  let opened = false;
  const view = renderWithProviders(<EpisodePage episodeId={EPISODE} />, {
    store,
    route,
    openStore: async () => {
      opened = true;
      return store;
    },
  });
  await screen.findByRole("list", { name: "Transcript" });
  // Saves are written through once browser storage has opened, as after any real page load.
  await vi.waitFor(() => expect(opened).toBe(true));
  await act(async () => {});
  const audio = document.querySelector("audio")!;
  controlAudio(audio);
  const fire = (type: string) => act(() => void audio.dispatchEvent(new Event(type)));
  return { ...view, store, put, audio, fire };
}

const record = (overrides: Partial<PlaybackRecord> = {}): PlaybackRecord => ({
  episodeId: EPISODE,
  positionMs: 6_000,
  durationMs: 9_000,
  updatedAt: "2026-10-05T12:00:00.000Z",
  finishedAt: null,
  ...overrides,
});

async function storeWith(saved: PlaybackRecord) {
  const store = new MemoryLearningStore();
  await store.putPlayback(saved);
  return store;
}

beforeEach(() => {
  now = 0;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("saving the listening position", () => {
  it("saves nothing for opening the episode or scrubbing without playing", async () => {
    const { put, fire, unmount } = await renderEpisode();
    now = 4;
    fire("seeked");
    fire("pause");
    unmount();
    expect(put).not.toHaveBeenCalled();
  });

  it("saves at most every 15 s while playing, skipping tiny moves", async () => {
    const { put, fire } = await renderEpisode();
    fire("play");
    now = 3;
    await act(async () => vi.advanceTimersByTime(SAVE_INTERVAL_MS - 100));
    expect(put).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(200));
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenLastCalledWith(
      expect.objectContaining({ episodeId: EPISODE, positionMs: 3_000, finishedAt: null }),
    );
    now = 3.5; // under a second later: not worth a write
    await act(async () => vi.advanceTimersByTime(SAVE_INTERVAL_MS));
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("saves right away on pause, page hidden, page hide and leaving", async () => {
    const { put, fire, unmount } = await renderEpisode();
    fire("play");
    now = 2;
    fire("pause");
    expect(put).toHaveBeenLastCalledWith(expect.objectContaining({ positionMs: 2_000 }));

    fire("play");
    now = 4;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(put).toHaveBeenLastCalledWith(expect.objectContaining({ positionMs: 4_000 }));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });

    now = 6;
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(put).toHaveBeenLastCalledWith(expect.objectContaining({ positionMs: 6_000 }));

    now = 8;
    unmount();
    expect(put).toHaveBeenLastCalledWith(expect.objectContaining({ positionMs: 8_000 }));
  });

  it("marks finished only on a real ended, and keeps it when leaving", async () => {
    const { put, fire, unmount } = await renderEpisode();
    fire("play");
    now = 8.9; // nearly at the end, paused: still not finished
    fire("pause");
    expect(put).toHaveBeenLastCalledWith(expect.objectContaining({ finishedAt: null }));
    fire("play");
    now = 9;
    fire("ended");
    const finished = put.mock.lastCall![0];
    expect(finished.finishedAt).not.toBeNull();
    expect(finished.positionMs).toBe(9_000);
    unmount();
    expect(put.mock.lastCall![0].finishedAt).toBe(finished.finishedAt);
  });

  it("stores only the five fields", async () => {
    const { put, fire } = await renderEpisode();
    fire("play");
    now = 3;
    fire("pause");
    expect(Object.keys(put.mock.lastCall![0]).sort()).toEqual(
      ["durationMs", "episodeId", "finishedAt", "positionMs", "updatedAt"].sort(),
    );
  });
});

describe.each([
  ["demo", false],
  ["local mode", true],
])("restoring the position (%s)", (_, local) => {
  beforeEach(() => vi.stubGlobal("__PEBBLE_LOCAL__", local));
  afterEach(() => vi.stubGlobal("__PEBBLE_LOCAL__", false));
  const seekbar = () => screen.getByRole("slider", { name: "Seek" });

  it("opens paused where the listener left off, with no resume controls", async () => {
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockClear();
    await renderEpisode(await storeWith(record()));
    expect(seekbar()).toHaveAttribute("aria-valuetext", "0:06 of 0:09");
    // The transcript follows the restored line.
    const scrolled = vi.mocked(Element.prototype.scrollIntoView).mock.contexts.at(-1);
    expect(scrolled).toHaveAttribute("data-segment-index", "2");
    expect(screen.queryByRole("group", { name: "Listening progress" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Resume|Start over|Listen again/ }),
    ).not.toBeInTheDocument();
    expect(play).not.toHaveBeenCalled();
  });

  it.each([
    ["nothing saved", undefined],
    ["a position under 5 s", record({ positionMs: 4_000 })],
    ["a finished episode", record({ positionMs: 9_000, finishedAt: "2026-10-05T12:05:00.000Z" })],
  ])("starts from the beginning for %s", async (_label, saved) => {
    await renderEpisode(saved ? await storeWith(saved) : undefined);
    expect(seekbar()).toHaveAttribute("aria-valuetext", "0:00 of 0:09");
  });

  it("leaves a cued line alone", async () => {
    await renderEpisode(await storeWith(record()), "/?segment=seg-2");
    expect(seekbar()).toHaveAttribute("aria-valuetext", "0:03 of 0:09");
  });
});
