/** Replaying a line starts 200 ms early; nothing else moves. Invented fixture content. */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test/fixtures.tsx";
import { EpisodePage } from "./EpisodePage.tsx";

// Fixture lines start at 0, 3000 and 6000 ms.
let now = 0; // the audio's currentTime, in seconds

function controlAudio() {
  const audio = document.querySelector("audio")!;
  Object.defineProperty(audio, "currentTime", {
    configurable: true,
    get: () => now,
    set: (value: number) => (now = value),
  });
  return audio;
}

async function renderEpisode(route = "/") {
  renderWithProviders(<EpisodePage episodeId="test-001" />, { route });
  const list = await screen.findByRole("list", { name: "Transcript" });
  const audio = controlAudio();
  const rows = within(list).getAllByRole("button", { name: /^\d+:\d\d/ });
  return { audio, rows };
}

const activeText = () =>
  screen.getAllByRole("button").find((b) => b.getAttribute("aria-current") === "true")
    ?.textContent ?? null;

beforeEach(() => {
  now = 0;
});

describe("replay pre-roll", () => {
  it("starts a clicked line 200 ms early and keeps it highlighted", async () => {
    const { rows } = await renderEpisode();
    await userEvent.click(rows[2]!);
    expect(now).toBeCloseTo(5.8);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(activeText()).toContain("第三句。"); // not the line the pre-roll plays over
  });

  it("starts the replay shortcut (R) 200 ms early", async () => {
    await renderEpisode();
    await userEvent.keyboard("{ArrowRight}"); // to line 2, exactly
    expect(now).toBe(3);
    await userEvent.keyboard("r");
    expect(now).toBeCloseTo(2.8);
    expect(activeText()).toContain("第二句。");
  });

  it("never starts the first line before 0", async () => {
    const { rows } = await renderEpisode();
    await userEvent.click(rows[0]!);
    expect(now).toBe(0);
  });

  it("lets go of the highlight once the line starts", async () => {
    const { audio, rows } = await renderEpisode();
    await userEvent.click(rows[2]!);
    now = 6.05;
    act(() => void audio.dispatchEvent(new Event("timeupdate")));
    expect(activeText()).toContain("第三句。");
    // Proof the hold is gone: back inside line 2 without a seek, line 2 is current again.
    now = 5.9;
    act(() => void audio.dispatchEvent(new Event("timeupdate")));
    expect(activeText()).toContain("第二句。");
  });

  it("lets go of the highlight when playback pauses", async () => {
    const { audio, rows } = await renderEpisode();
    await userEvent.click(rows[2]!);
    act(() => void audio.dispatchEvent(new Event("pause")));
    expect(activeText()).toContain("第二句。"); // the playhead (5.8 s) is still in line 2
  });

  it("lets go of the highlight when playback fails to start", async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
      new DOMException("blocked", "NotAllowedError"),
    );
    const { rows } = await renderEpisode();
    await userEvent.click(rows[2]!);
    await waitFor(() => expect(activeText()).toContain("第二句。"));
  });

  it("lets go of the highlight on any other seek", async () => {
    const { rows } = await renderEpisode();
    await userEvent.click(rows[2]!);
    fireEvent.change(screen.getByRole("slider", { name: "Seek" }), {
      target: { value: "5850" },
    });
    expect(now).toBeCloseTo(5.85); // the scrubber seeks exactly
    expect(activeText()).toContain("第二句。");
  });

  it("leaves arrow keys, line stepping and learning-item cues at exact starts", async () => {
    await renderEpisode("/?segment=seg-3");
    // The cue seeks on mount, before this test controls currentTime; the scrubber shows it.
    await waitFor(() => expect(screen.getByRole("slider", { name: "Seek" })).toHaveValue("6000"));
    await userEvent.keyboard("{ArrowLeft}");
    expect(now).toBe(3);
    await userEvent.click(screen.getByRole("button", { name: "Next line" }));
    expect(now).toBe(6);
  });
});
