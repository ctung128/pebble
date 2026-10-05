import { JobFailureCodeSchema } from "@pebble/schema";
import { describe, expect, it } from "vitest";
import { makeJob } from "../test/localFixtures.tsx";
import {
  activityLabel,
  FAILURE_COPY,
  failureCopy,
  requestProblem,
  statusLabel,
} from "./jobCopy.ts";

/** Words that would expose tools, internals or made-up precision. */
const UNSAFE =
  /ffmpeg|funasr|paraformer|worker|model|chunk|stack|trace|%|remaining|left|almost|minute/i;

describe("activityLabel", () => {
  it.each([
    [{ status: "queued" as const, stage: null, progress: null }, "Preparing audio…"],
    [{ status: "running" as const, stage: "probing" as const, progress: null }, "Preparing audio…"],
    [
      { status: "running" as const, stage: "normalizing" as const, progress: null },
      "Preparing audio…",
    ],
    [
      { status: "running" as const, stage: "chunking" as const, progress: null },
      "Preparing audio…",
    ],
    [
      { status: "running" as const, stage: "transcribing" as const, progress: null },
      "Processing audio…",
    ],
    [
      {
        status: "running" as const,
        stage: "transcribing" as const,
        progress: { completedChunks: 2, totalChunks: 7 },
      },
      "Processing section 3 of 7",
    ],
    [
      {
        status: "running" as const,
        stage: "transcribing" as const,
        progress: { completedChunks: 7, totalChunks: 7 },
      },
      "Processing section 7 of 7",
    ],
    [
      { status: "running" as const, stage: "merging" as const, progress: null },
      "Processing audio…",
    ],
  ])("states only what is known: %o → %s", (fields, label) => {
    expect(activityLabel(makeJob(fields))).toBe(label);
  });
});

describe("statusLabel", () => {
  it("says ready, never finished, for completed jobs", () => {
    expect(statusLabel(makeJob({ status: "completed", stage: "merging" }))).toBe("Preview ready");
    expect(
      statusLabel(
        makeJob({
          status: "completed",
          stage: "merging",
          provider: { id: "funasr", kind: "asr" },
        }),
      ),
    ).toBe("Transcript ready");
  });
});

describe("FAILURE_COPY", () => {
  it("covers every failure code in plain words with one next step", () => {
    for (const code of JobFailureCodeSchema.options) {
      const copy = FAILURE_COPY[code];
      expect(copy.reason).toMatch(/\.$/);
      expect(copy.next).toMatch(/\.$/);
      expect(`${copy.reason} ${copy.next}`).not.toMatch(UNSAFE);
    }
  });

  it("uses the code, never the worker's message or hint", () => {
    const job = makeJob({
      status: "failed",
      stage: "probing",
      failure: {
        stage: "probing",
        code: "FFMPEG_NOT_FOUND",
        message: "ffmpeg not found at /srv/pebble-test-data/bin",
        retryable: false,
        hint: "brew install ffmpeg",
      },
    });
    const copy = failureCopy(job);
    expect(copy.reason).toBe("Pebble isn't fully set up on this computer.");
    expect(JSON.stringify(copy)).not.toMatch(/ffmpeg|pebble-test-data|brew/i);
  });
});

describe("requestProblem", () => {
  it("names only known situations and otherwise uses the fallback", () => {
    expect(requestProblem("JOB_ACTIVE", "x")).toBe("This episode is still processing.");
    expect(requestProblem("UNREACHABLE", "x")).not.toMatch(UNSAFE);
    expect(requestProblem("SOMETHING_ELSE", "That didn't work. Try again.")).toBe(
      "That didn't work. Try again.",
    );
  });
});
