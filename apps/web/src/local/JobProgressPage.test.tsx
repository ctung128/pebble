import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Job } from "@pebble/schema";
import { fakeSource, testTranscript } from "../test/fixtures.tsx";
import { fakeWorkerClient, JOB_ID, makeJob, renderLocal } from "../test/localFixtures.tsx";
import { JobProgressRoute } from "./JobProgressPage.tsx";

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

describe("JobProgressPage", () => {
  it("shows the current stage and real section counts, never a percentage", async () => {
    renderJob(
      makeJob({
        status: "running",
        stage: "transcribing",
        progress: { completedChunks: 1, totalChunks: 5 },
      }),
    );
    expect(await screen.findByText("Processing section 2 of 5")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Processing sections");
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
    expect(screen.getByRole("status")).toHaveTextContent("Processing preview finished");
  });

  it("does not claim completion when the transcript doesn't validate", async () => {
    renderJob(makeJob({ status: "completed", stage: "merging" }), { transcriptFails: true });
    expect(await screen.findByText("Transcript is invalid")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("couldn't be read");
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
    expect(
      await screen.findByText("The mock provider failed on chunk 3 (simulated)."),
    ).toBeInTheDocument();
    expect(screen.getByText("PROVIDER_ERROR")).toBeInTheDocument();
    expect(screen.getByText("2 of 6 sections processed")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry from the start" }));
    expect(client.retryJob).toHaveBeenCalledWith(JOB_ID);
    expect(await screen.findByText("Attempt 2")).toBeInTheDocument();
  });

  it("offers no retry for permanent failures", async () => {
    renderJob(
      makeJob({
        status: "failed",
        stage: "probing",
        failure: { ...failure(false), stage: "probing" },
      }),
    );
    expect(await screen.findByText("Not audio.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
  });

  it("can cancel a running job and retry a cancelled one", async () => {
    const client = renderJob(makeJob({ status: "running", stage: "normalizing" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel processing" }));
    expect(client.cancelJob).toHaveBeenCalledWith(JOB_ID);
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
});
