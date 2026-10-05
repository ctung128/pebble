import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AudioPlayer } from "./useAudioPlayer.ts";
import { PlayerBar } from "./PlayerBar.tsx";

function fakePlayer(overrides: Partial<AudioPlayer> = {}): AudioPlayer {
  return {
    status: "ready",
    errorMessage: null,
    currentTimeMs: 14_000,
    durationMs: 34_000,
    isPlaying: false,
    playbackRate: 1,
    play: vi.fn(),
    pause: vi.fn(),
    toggle: vi.fn(),
    seek: vi.fn(),
    setPlaybackRate: vi.fn(),
    ...overrides,
  };
}

function renderBar(player = fakePlayer(), lineIndex = 4) {
  const handlers = { onPrevious: vi.fn(), onReplay: vi.fn(), onNext: vi.fn() };
  render(
    <PlayerBar
      player={player}
      lineIndex={lineIndex}
      lineCount={10}
      canGoPrevious
      canGoNext
      {...handlers}
    />,
  );
  return { player, ...handlers };
}

describe("PlayerBar", () => {
  it("puts play/pause first, then previous, replay and next", () => {
    renderBar();
    const region = screen.getByRole("region", { name: "Player" });
    const names = within(region)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual(["Play", "Previous line", "Replay current line", "Next line"]);
    expect(screen.getByRole("button", { name: "Replay current line" })).toHaveAttribute(
      "title",
      "Replay current line (R)",
    );
  });

  it("shows the time, the current line and the duration over a real slider", () => {
    renderBar();
    expect(screen.getByText(/· Line 5 of 10/)).toBeInTheDocument();
    expect(screen.getByText("0:34")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Seek" })).toHaveAttribute(
      "aria-valuetext",
      "0:14 of 0:34",
    );
  });

  it("leaves out the line count before the first line", () => {
    renderBar(fakePlayer({ currentTimeMs: 0 }), -1);
    expect(screen.queryByText(/Line \d+ of/)).not.toBeInTheDocument();
  });

  it("offers exactly three speeds as a labelled radio group", async () => {
    const { player } = renderBar();
    const group = screen.getByRole("group", { name: "Playback speed" });
    const options = within(group).getAllByRole("radio");
    expect(options.map((option) => option.closest("label")?.textContent)).toEqual([
      "0.75×",
      "0.9×",
      "1×",
    ]);
    expect(within(group).getByRole("radio", { name: "1×" })).toBeChecked();
    await userEvent.click(within(group).getByRole("radio", { name: "0.75×" }));
    expect(player.setPlaybackRate).toHaveBeenCalledWith(0.75);
  });

  it("disables every control and explains why when the audio fails", () => {
    renderBar(
      fakePlayer({ status: "error", errorMessage: "The audio file could not be decoded." }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("The audio file could not be decoded.");
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    expect(screen.getByRole("slider", { name: "Seek" })).toBeDisabled();
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
  });
});
