import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fakeWorkerClient, funasrHealth, makeJob, renderLocal } from "../test/localFixtures.tsx";
import { WorkerError } from "./workerClient.ts";
import { DELETE_PROMPT, LocalLibraryPage } from "./LocalLibraryPage.tsx";

const completed = makeJob({
  id: "job-aaaaaaaaaaaa",
  episodeId: "ep-aaaaaaaaaaaa",
  episodeTitle: "Finished walk",
  status: "completed",
  stage: "merging",
  progress: { completedChunks: 3, totalChunks: 3 },
});
const running = makeJob({
  id: "job-bbbbbbbbbbbb",
  episodeId: "ep-bbbbbbbbbbbb",
  episodeTitle: "Still going",
  status: "running",
  stage: "transcribing",
  progress: { completedChunks: 0, totalChunks: 4 },
});

describe("LocalLibraryPage", () => {
  it("lists local audio with status, preview labelling and the right actions", async () => {
    const client = fakeWorkerClient({ listJobs: vi.fn(async () => [completed, running]) });
    renderLocal(<LocalLibraryPage />, { client });
    const list = await screen.findByRole("list", { name: "Local audio" });
    const [done, active] = within(list).getAllByRole("listitem");

    expect(done).toHaveTextContent("Processing preview finished");
    expect(done).toHaveTextContent("Preview · placeholder text");
    expect(within(done!).getByRole("link", { name: "Open preview" })).toHaveAttribute(
      "href",
      "/episodes/ep-aaaaaaaaaaaa",
    );
    expect(within(done!).getByRole("button", { name: "Delete Finished walk" })).toBeInTheDocument();

    expect(active).toHaveTextContent("Processing section 1 of 4");
    expect(within(active!).getByRole("link", { name: "View progress" })).toHaveAttribute(
      "href",
      "/jobs/job-bbbbbbbbbbbb",
    );
    expect(within(active!).queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
  });

  it("deletes only after a confirmation that explains what is removed", async () => {
    const listJobs = vi.fn().mockResolvedValueOnce([completed]).mockResolvedValue([]);
    const client = fakeWorkerClient({ listJobs });
    renderLocal(<LocalLibraryPage />, { client });
    await userEvent.click(await screen.findByRole("button", { name: "Delete Finished walk" }));
    expect(screen.getByText(DELETE_PROMPT)).toBeInTheDocument();
    expect(DELETE_PROMPT).toMatch(/local audio.*sections.*preview transcript.*job record/);
    expect(client.deleteEpisode).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(client.deleteEpisode).toHaveBeenCalledWith("ep-aaaaaaaaaaaa");
    expect(await screen.findByText("No local audio yet")).toBeInTheDocument();
  });

  it("never offers deletion for ids that aren't local episodes", async () => {
    const odd = makeJob({ ...completed, episodeId: "demo-001" });
    renderLocal(<LocalLibraryPage />, {
      client: fakeWorkerClient({ listJobs: vi.fn(async () => [odd]) }),
    });
    await screen.findByRole("list", { name: "Local audio" });
    expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
  });

  it("retries a failed job from the list", async () => {
    const failed = makeJob({
      status: "failed",
      stage: "transcribing",
      failure: {
        stage: "transcribing",
        code: "PROVIDER_ERROR",
        message: "Boom.",
        retryable: true,
        hint: null,
      },
    });
    const client = fakeWorkerClient({ listJobs: vi.fn(async () => [failed]) });
    renderLocal(<LocalLibraryPage />, { client });
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(client.retryJob).toHaveBeenCalledWith(failed.id);
  });

  it("shows only the worker status when the worker isn't running", async () => {
    const client = fakeWorkerClient({
      health: async () => {
        throw new WorkerError("UNREACHABLE", "down");
      },
    });
    renderLocal(<LocalLibraryPage />, { client });
    expect(await screen.findByText("Pebble's local worker is not running.")).toBeInTheDocument();
    await waitFor(() => expect(client.listJobs).not.toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: "Process audio locally" })).not.toBeInTheDocument();
  });

  it("offers the mock's upload action", async () => {
    renderLocal(<LocalLibraryPage />, { client: fakeWorkerClient() });
    expect(await screen.findByRole("link", { name: "Process audio locally" })).toHaveAttribute(
      "href",
      "/process",
    );
  });
});

describe("LocalLibraryPage — local transcription (FunASR)", () => {
  const asr = { provider: { id: "funasr", kind: "asr" as const } };
  const jobs = [
    makeJob({
      ...asr,
      id: "job-aaaaaaaaaaaa",
      episodeId: "ep-aaaaaaaaaaaa",
      episodeTitle: "Done",
      status: "completed",
      stage: "merging",
      progress: { completedChunks: 1, totalChunks: 1 },
    }),
    makeJob({
      ...asr,
      id: "job-bbbbbbbbbbbb",
      episodeId: "ep-bbbbbbbbbbbb",
      episodeTitle: "Going",
      status: "running",
      stage: "transcribing",
      progress: { completedChunks: 1, totalChunks: 2 },
    }),
    makeJob({
      ...asr,
      id: "job-cccccccccccc",
      episodeId: "ep-cccccccccccc",
      episodeTitle: "Broke",
      status: "failed",
      stage: "merging",
      failure: {
        stage: "merging",
        code: "NO_SPEECH_DETECTED",
        message: "Pebble didn't find any speech in this audio, so there is no transcript.",
        retryable: false,
        hint: null,
      },
    }),
    makeJob({
      ...asr,
      id: "job-dddddddddddd",
      episodeId: "ep-dddddddddddd",
      episodeTitle: "Stopped",
      status: "cancelled",
      stage: "chunking",
      failure: {
        stage: "chunking",
        code: "CANCELLED",
        message: "Cancelled.",
        retryable: true,
        hint: null,
      },
    }),
  ];

  it("lists completed, running, failed and cancelled transcripts once FunASR is ready", async () => {
    const client = fakeWorkerClient({
      health: async () => ({ ok: true, data: funasrHealth() }),
      listJobs: vi.fn(async () => jobs),
    });
    renderLocal(<LocalLibraryPage />, { client });
    expect(await screen.findByText("Local transcription is ready.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create a transcript locally" })).toHaveAttribute(
      "href",
      "/process",
    );
    const list = await screen.findByRole("list", { name: "Local audio" });
    const [done, going, broke, stopped] = within(list).getAllByRole("listitem");
    expect(done).toHaveTextContent("Transcript finished");
    expect(within(done!).getByRole("link", { name: "Open transcript" })).toHaveAttribute(
      "href",
      "/episodes/ep-aaaaaaaaaaaa",
    );
    expect(going).toHaveTextContent("Processing section 2 of 2");
    expect(broke).toHaveTextContent("didn't find any speech");
    expect(stopped).toHaveTextContent("Cancelled");
    expect(list).not.toHaveTextContent(/placeholder|preview/i);
  });

  it("shows the setup state and no library while FunASR needs setup", async () => {
    const listJobs = vi.fn(async () => jobs);
    const client = fakeWorkerClient({
      health: async () => ({
        ok: true,
        data: funasrHealth({
          state: "models_missing",
          available: false,
          hint: "Download the speech models (about 1.3 GB) with: npm run pebble:setup",
        }),
      }),
      listJobs,
    });
    renderLocal(<LocalLibraryPage />, { client });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Pebble's local transcription needs setup.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(/Developer detail|uv sync|model\.pt/);
    expect(screen.queryByRole("list", { name: "Local audio" })).not.toBeInTheDocument();
    expect(listJobs).not.toHaveBeenCalled();
  });
});
