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

    // A finished row is quiet: it opens by its title, with no "finished" wording or Open button.
    expect(done).not.toHaveTextContent(/preview finished|transcript finished|ready/i);
    expect(done).toHaveTextContent("Preview · placeholder text");
    expect(within(done!).getByRole("link", { name: "Finished walk" })).toHaveAttribute(
      "href",
      "/episodes/ep-aaaaaaaaaaaa",
    );
    expect(within(done!).queryByRole("link", { name: /^Open/ })).not.toBeInTheDocument();
    expect(within(done!).getByRole("button", { name: "Delete Finished walk" })).toBeInTheDocument();

    expect(active).toHaveTextContent("Processing section 1 of 4");
    expect(within(active!).getByRole("link", { name: "View progress" })).toHaveAttribute(
      "href",
      "/jobs/job-bbbbbbbbbbbb",
    );
    expect(within(active!).queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
    expect(within(active!).queryByRole("link", { name: "Still going" })).not.toBeInTheDocument();
  });

  it("opens a finished row from its title by click or Enter", async () => {
    const client = fakeWorkerClient({ listJobs: vi.fn(async () => [completed]) });
    renderLocal(<LocalLibraryPage />, { client });
    await userEvent.click(await screen.findByRole("link", { name: "Finished walk" }));
    expect(await screen.findByText("Episode page ep-aaaaaaaaaaaa")).toBeInTheDocument();
  });

  it("opens a finished row with Enter on its focused link", async () => {
    const client = fakeWorkerClient({ listJobs: vi.fn(async () => [completed]) });
    renderLocal(<LocalLibraryPage />, { client });
    (await screen.findByRole("link", { name: "Finished walk" })).focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText("Episode page ep-aaaaaaaaaaaa")).toBeInTheDocument();
  });

  it("keeps Delete and its confirmation from opening the row", async () => {
    const client = fakeWorkerClient({ listJobs: vi.fn(async () => [completed]) });
    renderLocal(<LocalLibraryPage />, { client });
    await userEvent.click(await screen.findByRole("button", { name: "Delete Finished walk" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/Episode page/)).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Local audio" })).toBeInTheDocument();
  });

  it.each([
    [
      "long English",
      "A very long episode title about a slow walk through the morning market that keeps going on",
    ],
    ["Chinese", "周末去菜市场买了很多新鲜的蔬菜和水果，然后慢慢走回家做一顿午饭"],
    ["mixed script", "S1E2 慢慢听 | Slow listening: 一颗石子 and other stories"],
    ["unbroken", "an_extremely_long_unbroken_file_like_name_without_spaces_0123456789abcdef"],
  ])("keeps a %s title whole for assistive tech", async (_, title) => {
    const job = makeJob({ ...completed, episodeTitle: title });
    renderLocal(<LocalLibraryPage />, {
      client: fakeWorkerClient({ listJobs: vi.fn(async () => [job]) }),
    });
    const link = await screen.findByRole("link", { name: title });
    expect(link).toHaveTextContent(title); // clamping is visual only
    expect(link).not.toHaveAttribute("title"); // no hover-only tooltip
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
    expect(await screen.findByText("Pebble isn't running on this computer.")).toBeInTheDocument();
    await waitFor(() => expect(client.listJobs).not.toHaveBeenCalled());
  });

  it("leaves adding audio to the sidebar: no upload action on the page", async () => {
    renderLocal(<LocalLibraryPage />, { client: fakeWorkerClient() });
    expect(await screen.findByText("No local audio yet")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Add audio|Process audio/ })).not.toBeInTheDocument();
  });

  it("says nothing about readiness or the tools behind it once Pebble is ready", async () => {
    renderLocal(<LocalLibraryPage />, { client: fakeWorkerClient() });
    await screen.findByText("No local audio yet");
    expect(document.body).not.toHaveTextContent(/ready|ffmpeg|worker|funasr|\d+\.\d+\.\d+/i);
    expect(screen.queryByText(/Audio you processed/)).not.toBeInTheDocument();
  });

  it("heads the page with the Library index and real counts", async () => {
    const failed = makeJob({
      id: "job-cccccccccccc",
      status: "failed",
      stage: "probing",
      failure: {
        stage: "probing",
        code: "UNSUPPORTED_MEDIA",
        message: "Pebble can't read this file.",
        retryable: false,
        hint: null,
      },
    });
    const client = fakeWorkerClient({ listJobs: vi.fn(async () => [completed, running, failed]) });
    renderLocal(<LocalLibraryPage />, { client });
    expect(screen.getByRole("heading", { level: 1, name: "Library" })).toBeInTheDocument();
    expect(screen.queryByText("Your local audio")).not.toBeInTheDocument();
    expect(screen.queryByText(/01 — Library/)).not.toBeInTheDocument();
    expect(await screen.findByText("3 episodes · 1 processing · 1 stopped")).toBeInTheDocument();
  });

  it("names the stage, not a made-up ratio, before section counts exist", async () => {
    const queued = makeJob({ status: "queued", stage: null, progress: null });
    const preparing = makeJob({
      id: "job-dddddddddddd",
      status: "running",
      stage: "normalizing",
      progress: null,
    });
    const client = fakeWorkerClient({ listJobs: vi.fn(async () => [queued, preparing]) });
    renderLocal(<LocalLibraryPage />, { client });
    const list = await screen.findByRole("list", { name: "Local audio" });
    const [waiting, normalizing] = within(list).getAllByRole("listitem");
    expect(waiting).toHaveTextContent("Preparing audio…");
    expect(normalizing).toHaveTextContent("Preparing audio…");
    expect(list).not.toHaveTextContent(/%|left|almost/i);
  });

  it("keeps a retryable failure's details reachable beside Retry", async () => {
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
    renderLocal(<LocalLibraryPage />, {
      client: fakeWorkerClient({ listJobs: vi.fn(async () => [failed]) }),
    });
    const [row] = within(await screen.findByRole("list", { name: "Local audio" })).getAllByRole(
      "listitem",
    );
    expect(row).toHaveTextContent(
      "Couldn't process this audio. Something went wrong while processing.",
    );
    expect(row).not.toHaveTextContent("Boom."); // the worker's own message never shows
    expect(within(row!).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(within(row!).getByRole("link", { name: "Details" })).toHaveAttribute(
      "href",
      `/jobs/${failed.id}`,
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
    await screen.findByRole("list", { name: "Local audio" });
    expect(screen.queryByText(/is ready/)).not.toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Local audio" });
    const [done, going, broke, stopped] = within(list).getAllByRole("listitem");
    expect(done).not.toHaveTextContent(/finished|ready/i);
    expect(within(done!).getByRole("link", { name: "Done" })).toHaveAttribute(
      "href",
      "/episodes/ep-aaaaaaaaaaaa",
    );
    for (const row of [going, broke, stopped]) {
      expect(
        within(row!)
          .queryAllByRole("link")
          .filter((link) => link.getAttribute("href")?.startsWith("/episodes/")),
      ).toEqual([]);
    }
    expect(going).toHaveTextContent("Processing section 2 of 2");
    expect(broke).toHaveTextContent("No speech was found in this audio.");
    expect(broke).not.toHaveTextContent("didn't find any speech"); // worker wording stays out
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

  describe("row metadata (contract 1.7)", () => {
    const finished = (overrides: Partial<Parameters<typeof makeJob>[0]> = {}) =>
      makeJob({
        ...asr,
        id: "job-aaaaaaaaaaaa",
        episodeId: "ep-aaaaaaaaaaaa",
        episodeTitle: "Done",
        status: "completed",
        stage: "merging",
        progress: { completedChunks: 2, totalChunks: 2 },
        ...overrides,
      });
    async function rowFor(job: ReturnType<typeof makeJob>) {
      renderLocal(<LocalLibraryPage />, {
        client: fakeWorkerClient({
          health: async () => ({ ok: true, data: funasrHealth() }),
          listJobs: vi.fn(async () => [job]),
        }),
      });
      const list = await screen.findByRole("list", { name: "Local audio" });
      return within(list).getAllByRole("listitem")[0]!;
    }

    it("shows date · length · lines for a finished transcript", async () => {
      const row = await rowFor(finished({ durationMs: 768_000, lineCount: 214 }));
      expect(row.textContent).toMatch(/\b2026 · 12:48 · 214 lines/);
    });

    it("says 1 line, and h:mm:ss from an hour", async () => {
      const row = await rowFor(finished({ durationMs: 4_935_000, lineCount: 1 }));
      expect(row.textContent).toMatch(/2026 · 1:22:15 · 1 line(?!s)/);
    });

    it("never shows a line count for a preview", async () => {
      const row = await rowFor(
        finished({ provider: { id: "mock", kind: "mock" }, durationMs: 768_000, lineCount: 12 }),
      );
      expect(row).toHaveTextContent("· 12:48");
      expect(row).not.toHaveTextContent(/lines?\b/);
    });

    it("shows only the date while processing or when an older worker sends nothing", async () => {
      const going = makeJob({
        ...asr,
        status: "running",
        stage: "transcribing",
        progress: { completedChunks: 1, totalChunks: 3 },
        durationMs: 768_000,
      });
      expect((await rowFor(going)).textContent).not.toMatch(/12:48|0:00|lines?/);
    });

    it("leaves out a length and count the worker doesn't report (1.6)", async () => {
      const row = await rowFor(finished());
      expect(row.textContent).not.toMatch(/·|0:00|lines?/);
    });
  });
});
