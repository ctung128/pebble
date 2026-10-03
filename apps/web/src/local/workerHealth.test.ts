import { describe, expect, it } from "vitest";
import { parseWorkerHealth } from "@pebble/schema";
import { fakeWorkerClient, makeHealth } from "../test/localFixtures.tsx";
import { WorkerError } from "./workerClient.ts";
import { checkWorker } from "./workerHealth.ts";

const withHealth = (payload: unknown) =>
  fakeWorkerClient({ health: async () => parseWorkerHealth(payload) });

describe("checkWorker", () => {
  it("is ready when the worker, FFmpeg, data folder and mock provider are all fine", async () => {
    expect((await checkWorker(withHealth(makeHealth()))).kind).toBe("ready");
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

  it("reports an unavailable mock provider", async () => {
    const health = makeHealth({
      providers: [{ id: "mock", kind: "mock", available: false, detail: "Broken." }],
    });
    expect(await checkWorker(withHealth(health))).toEqual({
      kind: "provider-unavailable",
      detail: "Broken.",
    });
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
