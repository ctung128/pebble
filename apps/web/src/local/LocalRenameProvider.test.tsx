import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EpisodePage } from "../features/episode/EpisodePage.tsx";
import { fakeSource, renderWithProviders, testEpisode, testTranscript } from "../test/fixtures.tsx";
import { fakeWorkerClient, makeHealth, renderLocal } from "../test/localFixtures.tsx";
import { LocalRenameProvider, renameProblem } from "./LocalRenameProvider.tsx";
import { WorkerError } from "./workerClient.ts";

const EPISODE = "ep-0123456789ab";
const localSource = () =>
  fakeSource({
    getEpisode: async () => ({
      ...testEpisode,
      id: EPISODE,
      demo: undefined,
      audioProvenance: { kind: "user-provided", publishable: false, notes: "Yours." },
      audioUrl: "http://127.0.0.1:8790/episodes/x/audio",
    }),
    getTranscript: async () => ({ ...testTranscript, episodeId: EPISODE }),
  });

function renderEpisode(client = fakeWorkerClient()) {
  renderLocal(
    <LocalRenameProvider>
      <EpisodePage episodeId={EPISODE} />
    </LocalRenameProvider>,
    { client, source: localSource() },
  );
  return client;
}

describe("renameProblem", () => {
  it.each([
    [
      new WorkerError("INVALID_TITLE", "raw"),
      "Give the episode a title of 1–200 characters, on one line.",
    ],
    [new WorkerError("JOB_ACTIVE", "raw"), "This episode is still processing."],
    [new WorkerError("NOT_FOUND", "raw"), "This episode isn't in your library anymore."],
    [
      new WorkerError("UNREACHABLE", "raw"),
      "Pebble isn't responding. Check that it's running, then try again.",
    ],
    [
      new WorkerError("HTTP_ERROR", "Traceback at /srv/pebble-test-data"),
      "Couldn't rename. Try again.",
    ],
    [new Error("anything"), "Couldn't rename. Try again."],
  ])("never shows the worker's own words (%#)", (error, words) => {
    expect(renameProblem(error)).toBe(words);
  });
});

describe("Renaming a local episode", () => {
  it("renames from the episode page, updating the heading and tab title", async () => {
    const client = renderEpisode();
    await userEvent.click(await screen.findByRole("button", { name: "Rename episode" }));
    const field = screen.getByRole("textbox", { name: "Episode title" });
    await userEvent.clear(field);
    await userEvent.type(field, "Practice clip{Enter}");
    expect(client.renameEpisode).toHaveBeenCalledWith(EPISODE, "Practice clip");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Practice clip" }),
    ).toBeInTheDocument();
    expect(document.title).toBe("Practice clip · Pebble");
  });

  it("shows a safe message when the worker refuses", async () => {
    const client = fakeWorkerClient({
      renameEpisode: vi.fn(async () => {
        throw new WorkerError("HTTP_ERROR", "Traceback at /srv/pebble-test-data/x.wav");
      }),
    });
    renderEpisode(client);
    await userEvent.click(await screen.findByRole("button", { name: "Rename episode" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Episode title" }), "!{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't rename. Try again.");
    expect(alert).not.toHaveTextContent(/Traceback|pebble-test-data/);
  });

  it("offers no rename with a 1.6 worker", async () => {
    const client = fakeWorkerClient({
      health: vi.fn(async () => ({
        ok: true as const,
        data: makeHealth({ schemaVersion: "1.6" }),
      })),
    });
    renderEpisode(client);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Test episode" }),
    ).toBeInTheDocument();
    await screen.findByRole("list", { name: "Transcript" });
    expect(screen.queryByRole("button", { name: "Rename episode" })).not.toBeInTheDocument();
  });

  it("offers no rename in the demo", async () => {
    renderWithProviders(<EpisodePage episodeId="test-001" />);
    await screen.findByRole("list", { name: "Transcript" });
    expect(screen.queryByRole("button", { name: "Rename episode" })).not.toBeInTheDocument();
  });
});
