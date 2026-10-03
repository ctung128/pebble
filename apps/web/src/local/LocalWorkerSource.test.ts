import { describe, expect, it, vi } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "@pebble/schema";
import { SourceError } from "../data/EpisodeSource.ts";
import { testTranscript } from "../test/fixtures.tsx";
import { LocalWorkerSource } from "./LocalWorkerSource.ts";

const BASE = "http://127.0.0.1:8790";
const ID = "ep-0123456789ab";
const episode = {
  id: ID,
  title: "Morning walk",
  description: "Local audio · walk.m4a",
  language: "zh-CN",
  durationMs: 9000,
  audio: { src: `episodes/${ID}/audio`, mimeType: "audio/mp4" },
  transcript: { src: `episodes/${ID}/transcript` },
  audioProvenance: { kind: "user-provided", publishable: false, notes: "Yours." },
};
const mockTranscript = {
  ...testTranscript,
  episodeId: ID,
  provenance: { kind: "mock", provider: "mock", model: null, createdAt: "2026-10-03T00:00:00Z" },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function source(routes: Record<string, () => Response>) {
  const fetchImpl = vi.fn(async (url: string) => {
    const handler = routes[url.replace(`${BASE}/`, "")];
    return handler ? handler() : json({ error: { code: "NOT_FOUND" } }, 404);
  });
  return { source: new LocalWorkerSource(BASE, fetchImpl), fetchImpl };
}

async function errorFrom(promise: Promise<unknown>): Promise<SourceError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SourceError);
  return error as SourceError;
}

describe("LocalWorkerSource", () => {
  it("lists ready episodes from the worker", async () => {
    const { source: s } = source({
      episodes: () => json({ schemaVersion: CURRENT_SCHEMA_VERSION, episodes: [episode] }),
    });
    expect((await s.listEpisodes()).map((e) => e.id)).toEqual([ID]);
  });

  it("resolves audio to the worker's range-supporting endpoint", async () => {
    const { source: s } = source({ [`episodes/${ID}`]: () => json(episode) });
    expect((await s.getEpisode(ID)).audioUrl).toBe(`${BASE}/episodes/${ID}/audio`);
  });

  it("loads and validates mock transcripts", async () => {
    const { source: s } = source({ [`episodes/${ID}/transcript`]: () => json(mockTranscript) });
    expect((await s.getTranscript(ID)).provenance.kind).toBe("mock");
  });

  it("rejects malformed episodes and transcripts for another episode", async () => {
    const { source: s } = source({
      [`episodes/${ID}`]: () => json({ ...episode, durationMs: "long" }),
      [`episodes/${ID}/transcript`]: () =>
        json({ ...mockTranscript, episodeId: "ep-ffffffffffff" }),
    });
    expect((await errorFrom(s.getEpisode(ID))).code).toBe("INVALID_PAYLOAD");
    expect((await errorFrom(s.getTranscript(ID))).code).toBe("INVALID_PAYLOAD");
  });

  it("refuses non-local ids without contacting the worker", async () => {
    const { source: s, fetchImpl } = source({});
    expect((await errorFrom(s.getEpisode("demo-001"))).code).toBe("NOT_FOUND");
    expect((await errorFrom(s.getTranscript("../x"))).code).toBe("NOT_FOUND");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("explains an unreachable worker and unfinished episodes", async () => {
    const down = new LocalWorkerSource(BASE, () => Promise.reject(new TypeError("fetch failed")));
    const error = await errorFrom(down.listEpisodes());
    expect(error.code).toBe("NETWORK");
    expect(error.message).toContain("npm run worker");

    const { source: s } = source({
      [`episodes/${ID}`]: () => json({ error: { code: "EPISODE_NOT_READY" } }, 409),
    });
    expect((await errorFrom(s.getEpisode(ID))).message).toContain("hasn't finished processing");
  });

  it("has no extra review hints", async () => {
    expect(await new LocalWorkerSource(BASE).getReviewHints()).toEqual([]);
  });
});
