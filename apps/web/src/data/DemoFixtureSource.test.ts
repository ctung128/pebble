import { describe, expect, it, vi } from "vitest";
import { testEpisode, testTranscript } from "../test/fixtures.tsx";
import { DemoFixtureSource } from "./DemoFixtureSource.ts";
import { SourceError } from "./EpisodeSource.ts";

const BASE = "https://pebble.test/demo/";
const manifest = { schemaVersion: "1.0", episodes: [testEpisode] };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function sourceWith(routes: Record<string, () => Response | Promise<Response>>) {
  const fetchImpl = vi.fn(async (url: string) => {
    const handler = routes[url.replace(BASE, "")];
    return handler ? handler() : new Response("not found", { status: 404 });
  });
  return { source: new DemoFixtureSource(BASE, fetchImpl), fetchImpl };
}

async function errorFrom(promise: Promise<unknown>): Promise<SourceError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SourceError);
  return error as SourceError;
}

describe("DemoFixtureSource", () => {
  it("lists episodes and resolves audio URLs against the fixture base", async () => {
    const { source } = sourceWith({ "manifest.json": () => json(manifest) });
    expect(await source.listEpisodes()).toEqual([testEpisode]);
    expect((await source.getEpisode("test-001")).audioUrl).toBe(`${BASE}test-001/audio.m4a`);
  });

  it("loads a validated transcript", async () => {
    const { source } = sourceWith({
      "manifest.json": () => json(manifest),
      "test-001/transcript.json": () => json(testTranscript),
    });
    expect(await source.getTranscript("test-001")).toEqual(testTranscript);
  });

  it("fetches the manifest once", async () => {
    const { source, fetchImpl } = sourceWith({ "manifest.json": () => json(manifest) });
    await source.listEpisodes();
    await source.getEpisode("test-001");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports an unknown episode as NOT_FOUND", async () => {
    const { source } = sourceWith({ "manifest.json": () => json(manifest) });
    expect((await errorFrom(source.getEpisode("nope"))).code).toBe("NOT_FOUND");
  });

  it("reports a missing transcript file as NOT_FOUND", async () => {
    const { source } = sourceWith({ "manifest.json": () => json(manifest) });
    expect((await errorFrom(source.getTranscript("test-001"))).code).toBe("NOT_FOUND");
  });

  it("reports fetch failures as NETWORK and allows a retry", async () => {
    let fail = true;
    const { source } = sourceWith({
      "manifest.json": () => (fail ? Promise.reject(new TypeError("offline")) : json(manifest)),
    });
    expect((await errorFrom(source.listEpisodes())).code).toBe("NETWORK");
    fail = false;
    expect(await source.listEpisodes()).toHaveLength(1);
  });

  it("reports server errors as NETWORK", async () => {
    const { source } = sourceWith({ "manifest.json": () => json({}, 500) });
    expect((await errorFrom(source.listEpisodes())).code).toBe("NETWORK");
  });

  it("reports non-JSON as INVALID_PAYLOAD", async () => {
    const { source } = sourceWith({ "manifest.json": () => new Response("<html>") });
    expect((await errorFrom(source.listEpisodes())).code).toBe("INVALID_PAYLOAD");
  });

  it("reports contract violations as INVALID_PAYLOAD with issues", async () => {
    const broken = { ...testTranscript, segments: [{ ...testTranscript.segments[0], endMs: 0 }] };
    const { source } = sourceWith({
      "manifest.json": () => json(manifest),
      "test-001/transcript.json": () => json(broken),
    });
    const error = await errorFrom(source.getTranscript("test-001"));
    expect(error.code).toBe("INVALID_PAYLOAD");
    expect(error.details).toContainEqual(expect.objectContaining({ path: "segments.0.endMs" }));
  });

  it("reports a future major version as UNSUPPORTED_VERSION", async () => {
    const { source } = sourceWith({
      "manifest.json": () => json({ ...manifest, schemaVersion: "2.0" }),
    });
    expect((await errorFrom(source.listEpisodes())).code).toBe("UNSUPPORTED_VERSION");
  });

  it("returns no review hints for an episode without demo flags", async () => {
    const { source } = sourceWith({ "manifest.json": () => json(manifest) });
    expect(await source.getReviewHints("test-001")).toEqual([]);
  });

  it("marks demo review flags as illustrative", async () => {
    const flagged = {
      ...manifest,
      episodes: [{ ...testEpisode, demo: { illustrativeUncertainty: "test-001/flags.json" } }],
    };
    const { source } = sourceWith({
      "manifest.json": () => json(flagged),
      "test-001/flags.json": () =>
        json({
          schemaVersion: "1.0",
          episodeId: "test-001",
          kind: "illustrative",
          purpose: "UI testing",
          segments: [{ segmentId: "seg-2" }],
        }),
    });
    expect(await source.getReviewHints("test-001")).toEqual([
      { segmentId: "seg-2", source: "illustrative" },
    ]);
  });

  it("rejects a transcript that belongs to another episode", async () => {
    const { source } = sourceWith({
      "manifest.json": () => json(manifest),
      "test-001/transcript.json": () => json({ ...testTranscript, episodeId: "other-001" }),
    });
    expect((await errorFrom(source.getTranscript("test-001"))).code).toBe("INVALID_PAYLOAD");
  });
});
