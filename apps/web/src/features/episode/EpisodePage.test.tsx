import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { SourceError, type EpisodeSource } from "../../data/EpisodeSource.ts";
import { SourceProvider } from "../../data/SourceContext.tsx";
import { fakeSource } from "../../test/fixtures.ts";
import { EpisodePage } from "./EpisodePage.tsx";

function renderPage(source: EpisodeSource = fakeSource(), episodeId = "test-001") {
  render(
    <SourceProvider source={source}>
      <MemoryRouter>
        <EpisodePage episodeId={episodeId} />
      </MemoryRouter>
    </SourceProvider>,
  );
}

async function transcriptRows() {
  const list = await screen.findByRole("list", { name: "Transcript" });
  return within(list).getAllByRole("button");
}

const activeText = () =>
  screen.getAllByRole("button").find((b) => b.getAttribute("aria-current") === "true")
    ?.textContent ?? null;

describe("EpisodePage", () => {
  it("shows the episode, its transcript and the provenance notice", async () => {
    renderPage();
    expect(await transcriptRows()).toHaveLength(3);
    expect(screen.getByRole("heading", { name: "Test episode" })).toBeInTheDocument();
    expect(screen.getByText(/Development placeholder/)).toBeInTheDocument();
    expect(screen.getByText(/not speech-recognition output/)).toBeInTheDocument();
  });

  it("starts on the first line and steps with the arrow keys", async () => {
    renderPage();
    await transcriptRows();
    expect(activeText()).toContain("第一句。");

    await userEvent.keyboard("{ArrowRight}");
    expect(activeText()).toContain("第二句。");
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(activeText()).toContain("第三句。"); // clamps at the last line
    await userEvent.keyboard("{ArrowLeft}");
    expect(activeText()).toContain("第二句。");
  });

  it("seeks and plays when a line is clicked", async () => {
    renderPage();
    const rows = await transcriptRows();
    await userEvent.click(rows[2]!);
    expect(activeText()).toContain("第三句。");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it("toggles playback with Space and replays with R", async () => {
    renderPage();
    await transcriptRows();
    await userEvent.keyboard(" ");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("r");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
    expect(activeText()).toContain("第一句。");
  });

  it("does not activate a focused line when Space is pressed", async () => {
    renderPage();
    const rows = await transcriptRows();
    act(() => rows[2]!.focus());
    await userEvent.keyboard(" ");
    expect(activeText()).toContain("第一句。");
  });

  it("shows a structured error with retry when loading fails", async () => {
    let attempts = 0;
    const source = fakeSource({
      getTranscript: async () => {
        attempts += 1;
        throw new SourceError("INVALID_PAYLOAD", "Transcript is invalid: segments.0.endMs — bad");
      },
    });
    renderPage(source);
    expect(await screen.findByRole("alert")).toHaveTextContent("Content is malformed");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("alert");
    expect(attempts).toBe(2);
  });

  it("reports an unknown episode as not found", async () => {
    renderPage(fakeSource(), "missing");
    expect(await screen.findByRole("alert")).toHaveTextContent("Not found");
  });
});
