import { renderHook } from "@testing-library/react";
import type { Job } from "@pebble/schema";
import { describe, expect, it } from "vitest";
import { makeJob } from "../test/localFixtures.tsx";
import { useJobAnnouncements } from "./useJobAnnouncements.ts";

const running = (completedChunks: number) =>
  makeJob({
    episodeTitle: "Morning walk",
    status: "running",
    stage: "transcribing",
    progress: { completedChunks, totalChunks: 4 },
  });

function renderAnnouncements(initial: Job[] | null) {
  return renderHook(({ jobs }) => useJobAnnouncements(jobs), { initialProps: { jobs: initial } });
}

describe("useJobAnnouncements", () => {
  it("says nothing about what's already there on first load", () => {
    const { result } = renderAnnouncements([running(1)]);
    expect(result.current).toBe("");
  });

  it("stays quiet through section-by-section progress", () => {
    const { result, rerender } = renderAnnouncements([running(1)]);
    rerender({ jobs: [running(2)] });
    rerender({ jobs: [running(3)] });
    expect(result.current).toBe("");
  });

  it("announces each phase change once", () => {
    const { result, rerender } = renderAnnouncements([running(3)]);
    const done = makeJob({ ...running(4), status: "completed", stage: "merging" });
    rerender({ jobs: [done] });
    expect(result.current).toBe("Morning walk: preview ready.");
    rerender({ jobs: [{ ...done }] }); // the next poll, same phase
    expect(result.current).toBe("Morning walk: preview ready.");
  });

  it("announces a failure and a newly added job", () => {
    const { result, rerender } = renderAnnouncements([]);
    rerender({ jobs: [running(0)] });
    expect(result.current).toBe("Morning walk: processing started.");
    rerender({
      jobs: [
        makeJob({
          ...running(1),
          status: "failed",
          failure: {
            stage: "transcribing",
            code: "PROVIDER_ERROR",
            message: "x",
            retryable: true,
            hint: null,
          },
        }),
      ],
    });
    expect(result.current).toBe("Morning walk: couldn't be processed.");
  });
});
