import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fakeWorkerClient, funasrHealth, makeJob, renderLocal } from "../test/localFixtures.tsx";
import { CURRENT_SCHEMA_VERSION, type Correction, type LearningItem } from "@pebble/schema";
import { MemoryLearningStore } from "../features/learning/MemoryLearningStore.ts";
import { WorkerError } from "./workerClient.ts";
import { DELETE_PROMPT, LocalLibraryPage } from "./LocalLibraryPage.tsx";

/** Invented text only. */
function savedItem(id: string, episodeId: string): LearningItem {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id,
    kind: "segment",
    episodeId,
    episodeTitle: "Finished walk",
    segmentId: "seg-0001",
    startMs: 1000,
    endMs: 2500,
    text: "今天天气很好。",
    originalText: null,
    pinyin: "jīntiān tiānqì hěn hǎo.",
    translation: null,
    note: "my note",
    savedAt: "2026-10-04T10:00:00.000Z",
    updatedAt: "2026-10-04T10:00:00.000Z",
    provenance: {
      transcriptKind: "asr",
      transcriptProvider: "funasr",
      corrected: false,
      audioKind: "user-provided",
    },
  };
}

function correction(episodeId: string, segmentId: string): Correction {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    episodeId,
    segmentId,
    originalText: "原来的句子。",
    correctedText: "改过的句子。",
    updatedAt: "2026-10-04T10:00:00.000Z",
  };
}

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

  it("deletes only after a confirmation that explains what is removed and what stays", async () => {
    const listJobs = vi.fn().mockResolvedValueOnce([completed]).mockResolvedValue([]);
    const client = fakeWorkerClient({ listJobs });
    renderLocal(<LocalLibraryPage />, { client });
    await userEvent.click(await screen.findByRole("button", { name: "Delete Finished walk" }));
    expect(screen.getByText(DELETE_PROMPT)).toBeInTheDocument();
    expect(DELETE_PROMPT).toMatch(/removes the audio, its transcript, your edits to it/);
    expect(DELETE_PROMPT).toMatch(/Learning items you saved from it stay.*Source deleted/);
    expect(client.deleteEpisode).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(client.deleteEpisode).toHaveBeenCalledWith("ep-aaaaaaaaaaaa");
    expect(await screen.findByText("No local audio yet")).toBeInTheDocument();
  });

  it("after a delete, keeps learning items as source-deleted and removes only that episode's edits", async () => {
    const store = new MemoryLearningStore();
    const mine = savedItem("item-mine", "ep-aaaaaaaaaaaa");
    const other = savedItem("item-other", "ep-bbbbbbbbbbbb");
    await store.putItem(mine);
    await store.putItem(other);
    await store.putCorrection(correction("ep-aaaaaaaaaaaa", "seg-0001"));
    await store.putCorrection(correction("ep-aaaaaaaaaaaa", "seg-0002"));
    await store.putCorrection(correction("ep-bbbbbbbbbbbb", "seg-0001"));
    const listJobs = vi.fn().mockResolvedValueOnce([completed]).mockResolvedValue([]);
    renderLocal(<LocalLibraryPage />, { client: fakeWorkerClient({ listJobs }), store });

    await userEvent.click(await screen.findByRole("button", { name: "Delete Finished walk" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByText("No local audio yet");

    await waitFor(async () => {
      const items = await store.listItems();
      expect(items.find((i) => i.id === "item-mine")?.sourceDeletedAt).toBeTruthy();
    });
    const items = await store.listItems();
    expect(items).toHaveLength(2); // nothing deleted
    const kept = items.find((i) => i.id === "item-mine")!;
    expect({ ...kept, sourceDeletedAt: undefined, updatedAt: mine.updatedAt }).toEqual({
      ...mine,
      sourceDeletedAt: undefined,
    });
    expect(items.find((i) => i.id === "item-other")).toEqual(other);
    const left = await store.listCorrections();
    expect(left.map((c) => `${c.episodeId}/${c.segmentId}`)).toEqual(["ep-bbbbbbbbbbbb/seg-0001"]);
  });

  it("changes no browser data when the worker refuses the delete", async () => {
    const store = new MemoryLearningStore();
    await store.putItem(savedItem("item-mine", "ep-aaaaaaaaaaaa"));
    await store.putCorrection(correction("ep-aaaaaaaaaaaa", "seg-0001"));
    const client = fakeWorkerClient({
      listJobs: vi.fn(async () => [completed]),
      deleteEpisode: vi.fn(async () => {
        throw new WorkerError("JOB_ACTIVE", "This episode is still processing.");
      }),
    });
    renderLocal(<LocalLibraryPage />, { client, store });
    await userEvent.click(await screen.findByRole("button", { name: "Delete Finished walk" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This episode is still processing.");
    expect((await store.listItems())[0]?.sourceDeletedAt).toBeUndefined();
    expect(await store.listCorrections()).toHaveLength(1);
  });

  it("lists local audio by the learner's title only", async () => {
    const renamed = makeJob({ ...completed, episodeTitle: "Practice clip" });
    renderLocal(<LocalLibraryPage />, {
      client: fakeWorkerClient({ listJobs: vi.fn(async () => [renamed]) }),
    });
    expect(await screen.findByText("Practice clip")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/invented_private_interview|\.m4a/);
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
