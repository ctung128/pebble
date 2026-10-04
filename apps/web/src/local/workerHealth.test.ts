import { describe, expect, it } from "vitest";
import { parseWorkerHealth } from "@pebble/schema";
import { fakeWorkerClient, funasrHealth, makeHealth } from "../test/localFixtures.tsx";
import { WorkerError } from "./workerClient.ts";
import { checkWorker } from "./workerHealth.ts";

const withHealth = (payload: unknown) =>
  fakeWorkerClient({ health: async () => parseWorkerHealth(payload) });

describe("checkWorker", () => {
  it("is ready when the worker, FFmpeg, data folder and mock provider are all fine", async () => {
    expect(await checkWorker(withHealth(makeHealth()))).toMatchObject({
      kind: "ready",
      mode: "mock",
    });
  });

  it("reports a worker that isn't running", async () => {
    const client = fakeWorkerClient({
      health: async () => {
        throw new WorkerError("UNREACHABLE", "down");
      },
    });
    expect(await checkWorker(client)).toEqual({ kind: "not-running" });
  });

  it("reports a page the worker won't serve", async () => {
    const client = fakeWorkerClient({
      health: async () => {
        throw new WorkerError("ORIGIN_NOT_ALLOWED", "no", { status: 403 });
      },
    });
    expect(await checkWorker(client)).toEqual({ kind: "origin-blocked" });
  });

  it.each([
    ["a newer major data format", { ...makeHealth(), schemaVersion: "2.0" }],
    ["an older worker", { ...makeHealth(), schemaVersion: "1.1" }],
    ["an unreadable status report", { schemaVersion: "1.3", hello: "world" }],
  ])("reports a version mismatch for %s", async (_, payload) => {
    expect((await checkWorker(withHealth(payload))).kind).toBe("version-mismatch");
  });

  it("reports missing FFmpeg tools", async () => {
    const health = makeHealth({
      status: "degraded",
      tools: {
        ffmpeg: { available: true, version: "9.0" },
        ffprobe: { available: false, version: null },
      },
    });
    expect(await checkWorker(withHealth(health))).toEqual({
      kind: "needs-ffmpeg",
      missing: ["ffprobe"],
    });
  });

  it("reports an inaccessible data folder with the worker's path and hint", async () => {
    const health = makeHealth({
      status: "degraded",
      dataDirWritable: false,
      dataDir: { path: "~/.pebble", writable: false, hint: "Fix permissions." },
    });
    expect(await checkWorker(withHealth(health))).toEqual({
      kind: "data-dir",
      path: "~/.pebble",
      hint: "Fix permissions.",
    });
  });

  it("falls back to `available` for a worker that doesn't send a provider state", async () => {
    const broken = makeHealth({
      providers: [{ id: "mock", kind: "mock", available: false, detail: "Broken." }],
    });
    expect(await checkWorker(withHealth(broken))).toEqual({
      kind: "provider-unavailable",
      mode: "mock",
      hint: null,
    });
  });

  it("reports a mock provider that failed with its hint, never its developer detail", async () => {
    const health = makeHealth({
      providers: [
        {
          id: "mock",
          kind: "mock",
          available: false,
          detail: "Traceback (most recent call last)",
          state: "load_failed",
          hint: "Restart the worker and try again.",
        },
      ],
    });
    const status = await checkWorker(withHealth(health));
    expect(status).toEqual({
      kind: "provider-unavailable",
      mode: "mock",
      hint: "Restart the worker and try again.",
    });
    expect(JSON.stringify(status)).not.toContain("Traceback");
  });

  it("is ready for real transcription when FunASR is ready", async () => {
    expect(await checkWorker(withHealth(funasrHealth()))).toMatchObject({
      kind: "ready",
      mode: "funasr",
    });
  });

  it("reports FunASR still checking its models", async () => {
    const health = funasrHealth({ state: "checking", available: false });
    expect(await checkWorker(withHealth(health))).toEqual({
      kind: "provider-checking",
      mode: "funasr",
    });
  });

  it.each(["environment_missing", "models_missing", "verification_failed"] as const)(
    "reports FunASR %s as needing setup, with the worker's hint",
    async (state) => {
      const health = funasrHealth({ state, available: false, hint: "Do the one thing." });
      expect(await checkWorker(withHealth(health))).toEqual({
        kind: "provider-setup",
        mode: "funasr",
        hint: "Do the one thing.",
      });
    },
  );

  it("reports FunASR that couldn't load as unavailable", async () => {
    const health = funasrHealth({ state: "load_failed", available: false, hint: "Restart." });
    expect(await checkWorker(withHealth(health))).toEqual({
      kind: "provider-unavailable",
      mode: "funasr",
      hint: "Restart.",
    });
  });

  it("never treats a provider that claims ready but isn't available as ready", async () => {
    const health = funasrHealth({ state: "ready", available: false });
    expect((await checkWorker(withHealth(health))).kind).toBe("provider-unavailable");
  });

  it.each([
    ["an unknown provider", [{ id: "whisper", kind: "asr", available: true, detail: null }]],
    ["a wrong kind", [{ id: "funasr", kind: "mock", available: true, detail: null }]],
    ["a mock labelled as ASR", [{ id: "mock", kind: "asr", available: true, detail: null }]],
    ["no providers", []],
    [
      "more than one provider",
      [
        { id: "mock", kind: "mock", available: true, detail: null },
        { id: "funasr", kind: "asr", available: true, detail: null },
      ],
    ],
  ])("reports a configuration mismatch for %s", async (_, providers) => {
    const health = makeHealth({ providers: providers as never });
    expect(await checkWorker(withHealth(health))).toEqual({ kind: "provider-mismatch" });
  });

  it("checks FFmpeg before the data folder", async () => {
    const health = makeHealth({
      dataDirWritable: false,
      tools: {
        ffmpeg: { available: false, version: null },
        ffprobe: { available: false, version: null },
      },
    });
    expect((await checkWorker(withHealth(health))).kind).toBe("needs-ffmpeg");
  });
});
