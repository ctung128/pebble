/** Listening position: saved conservatively, offered back only on request. Invented content. */
import { act, fireEvent, screen } from "@testing-library/react";
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

describe("resume controls", () => {
  it("offers Resume and Start over for a saved position, without playing on load", async () => {
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockClear();
    await renderEpisode(await storeWith(record()));
    expect(screen.getByRole("group", { name: "Listening progress" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume 0:06" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start over" })).toBeInTheDocument();
    expect(play).not.toHaveBeenCalled();
    expect(now).toBe(0);
  });

  it("resumes from the saved position only when asked", async () => {
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockClear();
    await renderEpisode(await storeWith(record()));
    fireEvent.click(screen.getByRole("button", { name: "Resume 0:06" }));
    expect(now).toBe(6);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("starts over from zero and forgets the saved position", async () => {
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockClear();
    now = 5;
    const { store } = await renderEpisode(await storeWith(record()));
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(now).toBe(0);
    expect(play).toHaveBeenCalledTimes(1);
    await act(async () => {});
    expect(await store.listPlayback()).toEqual([]);
  });

  it("offers Listen again after a real finish", async () => {
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockClear();
    const { store } = await renderEpisode(
      await storeWith(record({ positionMs: 9_000, finishedAt: "2026-10-05T12:05:00.000Z" })),
    );
    expect(screen.getByRole("group", { name: "Listening progress" })).toHaveTextContent(
      "Finished·Listen again",
    );
    fireEvent.click(screen.getByRole("button", { name: "Listen again" }));
    expect(now).toBe(0);
    expect(play).toHaveBeenCalledTimes(1);
    await act(async () => {});
    expect(await store.listPlayback()).toEqual([]);
  });

  it("goes away once playback starts", async () => {
    const { fire } = await renderEpisode(await storeWith(record()));
    fire("play");
    expect(screen.queryByRole("group", { name: "Listening progress" })).not.toBeInTheDocument();
  });

  it.each([
    ["under 5 s", record({ positionMs: 4_000 })],
    ["from an episode that has since changed length", record({ durationMs: 60_000 })],
  ])("offers nothing for a position %s", async (_, saved) => {
    await renderEpisode(await storeWith(saved));
    expect(screen.queryByRole("group", { name: "Listening progress" })).not.toBeInTheDocument();
  });

  it("stays out of the way when arriving to a specific line", async () => {
    await renderEpisode(await storeWith(record()), "/?segment=seg-2");
    expect(screen.queryByRole("group", { name: "Listening progress" })).not.toBeInTheDocument();
  });
});
