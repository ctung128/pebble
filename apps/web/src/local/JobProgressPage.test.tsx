import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Job } from "@pebble/schema";
import { fakeSource, testTranscript } from "../test/fixtures.tsx";
import { fakeWorkerClient, JOB_ID, makeJob, renderLocal } from "../test/localFixtures.tsx";
import { JobProgressRoute } from "./JobProgressPage.tsx";
import { LocalRenameProvider } from "./LocalRenameProvider.tsx";

function renderJob(jobs: Job[] | Job, options: { transcriptFails?: boolean } = {}) {
  const sequence = Array.isArray(jobs) ? jobs : [jobs];
  const getJob = vi.fn(async () => (sequence.length > 1 ? sequence.shift()! : sequence[0]!));
  const client = fakeWorkerClient({ getJob });
  const source = fakeSource({
    getTranscript: options.transcriptFails
      ? async () => {
          throw new Error("Transcript is invalid");
        }
      : async () => testTranscript,
  });
  renderLocal(<JobProgressRoute />, {
    client,
    source,
    path: "/jobs/:jobId",
    route: `/jobs/${JOB_ID}`,
  });
  return client;
}

const failure = (retryable: boolean) => ({
  stage: "transcribing" as const,
  code: retryable ? ("PROVIDER_ERROR" as const) : ("UNSUPPORTED_MEDIA" as const),
  message: retryable ? "The mock provider failed on chunk 3 (simulated)." : "Not audio.",
  retryable,
  hint: retryable ? "Retry the job." : null,
});

/** The visible headline (the polite live region is separate, and throttled). */
const headline = () => document.getElementById("job-status")!;

describe("JobProgressPage", () => {
  it("shows the current stage and real section counts, never a percentage", async () => {
    renderJob(
      makeJob({
        status: "running",
        stage: "transcribing",
        progress: { completedChunks: 1, totalChunks: 5 },
      }),
    );
    expect(await screen.findByText("Processing section 2 of 5")).toBe(headline());
    // The steps stay in view while processing, not behind a disclosure.
    expect(screen.getByRole("list", { name: "Stages" }).closest("details")).toBeNull();
    expect(screen.getByText("Section 2 of 5 · 1 done")).toBeInTheDocument();
    const stages = screen.getAllByRole("listitem").map((li) => li.getAttribute("data-state"));
    expect(stages).toEqual(["done", "done", "done", "current", "pending"]);
    expect(document.body.textContent).not.toMatch(/%/);
    expect(document.body.textContent).not.toMatch(/transcribing/i);
  });

  it("only offers the transcript once it loads and validates", async () => {
    renderJob(
      makeJob({
        status: "completed",
        stage: "merging",
        progress: { completedChunks: 2, totalChunks: 2 },
      }),
    );
    expect(await screen.findByRole("link", { name: "Open preview transcript" })).toHaveAttribute(
      "href",
      "/episodes/ep-0123456789ab",
    );
    expect(headline()).toHaveTextContent("Preview ready");
  });

  it("does not claim completion when the transcript doesn't validate", async () => {
    renderJob(makeJob({ status: "completed", stage: "merging" }), { transcriptFails: true });
    expect(await screen.findByText("Try processing this audio again.")).toBeInTheDocument();
    expect(headline()).toHaveTextContent("couldn't be read");
    expect(screen.queryByText("Transcript is invalid")).not.toBeInTheDocument(); // raw reason stays out
    expect(screen.queryByRole("link", { name: "Open preview transcript" })).not.toBeInTheDocument();
  });

  it("shows a retryable failure and retries from the start", async () => {
    const client = renderJob([
      makeJob({
        status: "failed",
        stage: "transcribing",
        failure: failure(true),
        progress: { completedChunks: 2, totalChunks: 6 },
      }),
      makeJob({ status: "queued", attempt: 2 }),
    ]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong while processing.");
    expect(alert).toHaveTextContent("Try again. If it keeps happening, restart Pebble.");
    // The worker's message, hint and code stay out of the UI, and so does the attempt count.
    expect(document.body).not.toHaveTextContent(
      /mock provider|chunk 3|PROVIDER_ERROR|Retry the job|Attempt/,
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry from the start" }));
    expect(client.retryJob).toHaveBeenCalledWith(JOB_ID);
    expect(await screen.findByText("Waiting to start…")).toBeInTheDocument();
  });

  it("offers no retry for permanent failures", async () => {
    renderJob(
      makeJob({
        status: "failed",
        stage: "probing",
        failure: { ...failure(false), stage: "probing" },
      }),
    );
    expect(await screen.findByText("This file type isn't supported.")).toBeInTheDocument();
    expect(screen.getByText("Try an MP3, M4A or WAV file.")).toBeInTheDocument();
    expect(screen.queryByText("Not audio.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
  });

  it("cancels only after a confirmation that says what stopping means", async () => {
    const client = renderJob(makeJob({ status: "running", stage: "normalizing" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel processing" }));
    expect(
      screen.getByText("Stop processing? You can start it again later, from the beginning."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Keep processing" }));
    expect(client.cancelJob).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Cancel processing" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop processing" }));
    expect(client.cancelJob).toHaveBeenCalledWith(JOB_ID);
  });

  it("says once, while active, that leaving is safe while Pebble runs", async () => {
    renderJob(makeJob({ status: "queued", stage: null }));
    expect(await screen.findByText("Waiting to start…")).toBeInTheDocument();
    expect(
      screen.getAllByText(
        "Processing continues while Pebble is running and your computer stays awake. You can leave this page.",
      ),
    ).toHaveLength(1);
    expect(screen.getByRole("link", { name: "← Library" })).toHaveAttribute("href", "/");
  });

  it("drops the note once processing has ended", async () => {
    renderJob(makeJob({ status: "completed", stage: "merging" }));
    expect(await screen.findByText("Preview ready")).toBeInTheDocument();
    expect(screen.queryByText(/Processing continues/)).not.toBeInTheDocument();
  });

  it("explains a worker stop plainly, with a way to start again", async () => {
    renderJob(
      makeJob({
        status: "failed",
        stage: "transcribing",
        failure: {
          stage: "transcribing",
          code: "WORKER_RESTARTED",
          message: "The worker stopped while this job was running.",
          retryable: true,
          hint: "Retry to process the audio again from the start.",
        },
      }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Pebble stopped before processing finished.");
    expect(alert).toHaveTextContent("Try again to restart processing.");
    expect(alert).not.toHaveTextContent(/worker/i);
    expect(screen.getByRole("button", { name: "Retry from the start" })).toBeInTheDocument();
  });

  it("shows a cancelled job with retry", async () => {
    renderJob(
      makeJob({
        status: "cancelled",
        stage: "transcribing",
        failure: {
          stage: "transcribing",
          code: "CANCELLED",
          message: "Cancelled.",
          retryable: true,
          hint: null,
        },
      }),
    );
    expect(await screen.findByRole("button", { name: "Retry from the start" })).toBeInTheDocument();
    expect(document.getElementById("job-status")).toHaveTextContent("Cancelled");
  });

  it("keeps the mock's preview wording", async () => {
    renderJob(makeJob({ status: "running", stage: "merging" }));
    expect(await screen.findByText("Preparing processing preview")).toBeInTheDocument();
    expect(headline()).toHaveTextContent("Processing audio…");
    // The stage names (never "transcribing" for the mock) stay in the steps disclosure.
    expect(screen.getByText("Assembling the preview transcript")).toBeInTheDocument();
  });
});

describe("JobProgressPage — local transcription (FunASR)", () => {
  const asr = { provider: { id: "funasr", kind: "asr" as const } };

  it("describes creating a transcript, with real section counts only", async () => {
    renderJob(
      makeJob({
        ...asr,
        status: "running",
        stage: "transcribing",
        progress: { completedChunks: 0, totalChunks: 3 },
      }),
    );
    expect(await screen.findByText("Creating your transcript")).toBeInTheDocument();
    expect(screen.getByText("Processing section 1 of 3")).toBeInTheDocument();
    const stages = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(stages.at(-1)).toBe("Assembling the transcript");
    expect(document.body.textContent).not.toMatch(/%|preview|placeholder/i);
  });

  it("opens the real transcript when finished", async () => {
    renderJob(
      makeJob({
        ...asr,
        status: "completed",
        stage: "merging",
        progress: { completedChunks: 1, totalChunks: 1 },
      }),
    );
    const open = await screen.findByRole("link", { name: "Open transcript" });
    expect(open).toHaveAttribute("href", "/episodes/ep-0123456789ab");
    expect(headline()).toHaveTextContent("Transcript ready");
    expect(screen.queryByText("Creating your transcript")).not.toBeInTheDocument(); // it's done
    expect(screen.queryByText(/preview/i)).not.toBeInTheDocument();
  });
});

describe("JobProgressPage — rename", () => {
  const failed = makeJob({
    status: "failed",
    stage: "probing",
    failure: {
      stage: "probing",
      code: "UNSUPPORTED_MEDIA",
      message: "x",
      retryable: false,
      hint: null,
    },
  });

  function renderWithRename(job: Job) {
    const client = fakeWorkerClient({ getJob: vi.fn(async () => job) });
    renderLocal(
      <LocalRenameProvider>
        <JobProgressRoute />
      </LocalRenameProvider>,
      { client, path: "/jobs/:jobId", route: `/jobs/${JOB_ID}` },
    );
    return client;
  }

  it("renames a failed episode from its processing page", async () => {
    const client = renderWithRename(failed);
    await userEvent.click(await screen.findByRole("button", { name: "Rename episode" }));
    const field = screen.getByRole("textbox", { name: "Episode title" });
    await userEvent.clear(field);
    await userEvent.type(field, "Broken clip{Enter}");
    expect(client.renameEpisode).toHaveBeenCalledWith(failed.episodeId, "Broken clip");
  });

  it("offers no rename while the episode is processing", async () => {
    renderWithRename(makeJob({ status: "running", stage: "normalizing" }));
    expect(await screen.findByText("Preparing audio…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename episode" })).not.toBeInTheDocument();
  });
});

describe("JobProgressPage — progress", () => {
  const asr = { provider: { id: "funasr", kind: "asr" as const } };
  const sections = (completedChunks: number, totalChunks = 4) =>
    makeJob({
      ...asr,
      status: "running",
      stage: "transcribing",
      durationMs: 42 * 60_000,
      progress: { completedChunks, totalChunks },
    });

  it("fills the bar from real section counts and says how much audio there is", async () => {
    renderJob(sections(1));
    const bar = await screen.findByRole("progressbar", { name: "Sections processed" });
    expect(bar).toHaveAttribute("aria-valuenow", "1");
    expect(bar).toHaveAttribute("aria-valuemax", "4");
    expect(bar).toHaveAttribute("aria-valuetext", "1 of 4 sections");
    expect(screen.getByText("42 min of audio · 4 sections")).toBeInTheDocument();
  });

  it("sweeps without a value before section counts exist", async () => {
    renderJob(makeJob({ status: "running", stage: "normalizing" }));
    const bar = await screen.findByRole("progressbar", { name: "Processing" });
    expect(bar).not.toHaveAttribute("aria-valuenow");
  });

  it("warns that the first section can take longer, for real transcription only", async () => {
    renderJob(sections(0));
    expect(
      await screen.findByText("Section 1 of 4 · 0 done. The first section can take longer."),
    ).toBeInTheDocument();
  });

  it("shows a running clock from when the audio was added, first attempt only", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.parse("2026-10-03T12:03:07.000Z") });
    try {
      renderJob(sections(1));
      expect(await screen.findByText("Running for 3:07")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the progress in the tab title", async () => {
    renderJob(sections(2));
    await screen.findByText("Processing section 3 of 4");
    expect(document.title).toBe("(2/4) Morning walk · Pebble");
  });

  it("estimates the time left only after seeing two sections finish", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const sequence = [sections(0, 6), sections(1, 6), sections(2, 6), sections(3, 6)];
      const getJob = vi.fn(async () => (sequence.length > 1 ? sequence.shift()! : sequence[0]!));
      renderLocal(<JobProgressRoute />, {
        client: fakeWorkerClient({ getJob }),
        source: fakeSource({ getTranscript: async () => testTranscript }),
        path: "/jobs/:jobId",
        route: `/jobs/${JOB_ID}`,
      });
      await screen.findByText("Processing section 1 of 6");
      await act(() => vi.advanceTimersByTimeAsync(1000)); // 1 done: first change seen
      expect(screen.queryByText(/left/)).not.toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(1000)); // 2 done
      await act(() => vi.advanceTimersByTimeAsync(1000)); // 3 done
      expect(screen.getByText(/Less than a minute left|About \d+ min left/)).toBeInTheDocument();
      expect(screen.getByText("· estimate")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows only the headline and a full bar once finished", async () => {
    renderJob(
      makeJob({
        ...asr,
        status: "completed",
        stage: "merging",
        progress: { completedChunks: 4, totalChunks: 4 },
      }),
    );
    await screen.findByRole("link", { name: "Open transcript" });
    expect(screen.queryByRole("list", { name: "Stages" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Processed/)).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    // The ✓ waits for the transcript to load and validate.
    await waitFor(() => expect(document.title).toBe("✓ Morning walk · Pebble"));
  });

  it("announces stage changes, not every section", async () => {
    renderJob([
      makeJob({ status: "running", stage: "chunking" }),
      makeJob({
        status: "running",
        stage: "transcribing",
        progress: { completedChunks: 0, totalChunks: 4 },
      }),
      makeJob({
        status: "running",
        stage: "transcribing",
        progress: { completedChunks: 1, totalChunks: 4 },
      }),
    ]);
    const live = () => screen.getByRole("status");
    await screen.findByText("Preparing audio…");
    expect(live()).toHaveTextContent(""); // the first load isn't news
    await screen.findByText("Processing section 1 of 4", {}, { timeout: 3000 });
    expect(live()).toHaveTextContent("Processing section 1 of 4");
    await screen.findByText("Processing section 2 of 4", {}, { timeout: 3000 });
    expect(live()).toHaveTextContent("Processing section 1 of 4"); // a section tick says nothing yet
  });
});
