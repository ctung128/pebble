import { CURRENT_SCHEMA_VERSION } from "@pebble/schema";
import { describe, expect, it, vi } from "vitest";
import { makeJob } from "../test/localFixtures.tsx";
import { HttpWorkerClient, WorkerError } from "./workerClient.ts";

const BASE = "http://127.0.0.1:8790";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function errorFrom(promise: Promise<unknown>): Promise<WorkerError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WorkerError);
  return error as WorkerError;
}

describe("HttpWorkerClient (fetch)", () => {
  it("validates jobs against the contract", async () => {
    const fetchImpl = vi.fn(async () => json(makeJob({ status: "running", stage: "probing" })));
    const client = new HttpWorkerClient(BASE, { fetchImpl });
    expect((await client.getJob("job-0123456789ab")).stage).toBe("probing");
    expect(fetchImpl).toHaveBeenCalledWith(`${BASE}/jobs/job-0123456789ab`, expect.anything());
  });

  it("rejects malformed job payloads", async () => {
    const client = new HttpWorkerClient(BASE, { fetchImpl: async () => json({ id: "x" }) });
    expect((await errorFrom(client.getJob("job-0123456789ab"))).code).toBe("INVALID_RESPONSE");
  });

  it("reports an unreachable worker", async () => {
    const client = new HttpWorkerClient(BASE, {
      fetchImpl: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    const error = await errorFrom(client.listJobs());
    expect(error.code).toBe("UNREACHABLE");
    expect(error.hint).toBe("Start it with npm run pebble:start.");
  });

  it("surfaces the worker's error envelope", async () => {
    const client = new HttpWorkerClient(BASE, {
      fetchImpl: async () =>
        json({ error: { code: "JOB_NOT_RETRYABLE", message: "Nope.", hint: "Fix it." } }, 409),
    });
    const error = await errorFrom(client.retryJob("job-0123456789ab"));
    expect(error).toMatchObject({ code: "JOB_NOT_RETRYABLE", status: 409, hint: "Fix it." });
  });

  it("renames with a JSON PATCH of the title only, for local episode ids only", async () => {
    const fetchImpl = vi.fn(async () =>
      json(makeJob({ episodeTitle: "New", status: "completed", stage: "merging" })),
    );
    const client = new HttpWorkerClient(BASE, { fetchImpl });
    expect((await errorFrom(client.renameEpisode("demo-001", "x"))).code).toBe("NOT_FOUND");
    expect(fetchImpl).not.toHaveBeenCalled();
    const job = await client.renameEpisode("ep-0123456789ab", "New");
    expect(job.episodeTitle).toBe("New");
    expect(fetchImpl).toHaveBeenCalledWith(`${BASE}/episodes/ep-0123456789ab`, {
      method: "PATCH",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New" }),
    });
  });

  it("never sends deletes for anything but a local episode id", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new HttpWorkerClient(BASE, { fetchImpl });
    for (const bad of ["demo-001", "../..", "ep-../../x", "EP-0123456789AB"]) {
      expect((await errorFrom(client.deleteEpisode(bad))).code).toBe("INVALID_EPISODE");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    await client.deleteEpisode("ep-0123456789ab");
    expect(fetchImpl).toHaveBeenCalledWith(
      `${BASE}/episodes/ep-0123456789ab`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("refuses malformed job ids without a request", async () => {
    const fetchImpl = vi.fn();
    const client = new HttpWorkerClient(BASE, { fetchImpl });
    expect((await errorFrom(client.getJob("../health"))).code).toBe("NOT_FOUND");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/** Minimal XMLHttpRequest stand-in that the test drives by hand. */
class FakeXhr {
  static last: FakeXhr;
  method = "";
  url = "";
  body: FormData | null = null;
  status = 0;
  responseText = "";
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  aborted = false;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

function xhrClient() {
  return new HttpWorkerClient(BASE, {
    createXhr: () => new FakeXhr() as unknown as XMLHttpRequest,
  });
}

const audioFile = () => new File(["abc"], "walk.m4a", { type: "audio/mp4" });

describe("HttpWorkerClient.upload (XHR)", () => {
  it("posts the file, title and ownership confirmation and reports progress", async () => {
    const onProgress = vi.fn();
    const pending = xhrClient().upload({
      file: audioFile(),
      title: "Morning walk",
      ownershipConfirmed: true,
      onProgress,
    });
    const xhr = FakeXhr.last;
    expect([xhr.method, xhr.url]).toEqual(["POST", `${BASE}/episodes`]);
    expect(xhr.body?.get("title")).toBe("Morning walk");
    expect(xhr.body?.get("ownershipConfirmed")).toBe("true");
    expect((xhr.body?.get("file") as File).name).toBe("walk.m4a");

    xhr.progress(1, 3);
    xhr.progress(3, 3);
    expect(onProgress.mock.calls).toEqual([[{ loaded: 1, total: 3 }], [{ loaded: 3, total: 3 }]]);

    xhr.respond(201, { job: makeJob() });
    expect((await pending).id).toBe("job-0123456789ab");
  });

  it("turns worker refusals into structured errors", async () => {
    const pending = xhrClient().upload({ file: audioFile(), title: "x", ownershipConfirmed: true });
    FakeXhr.last.respond(413, { error: { code: "FILE_TOO_LARGE", message: "Too big." } });
    expect(await errorFrom(pending)).toMatchObject({ code: "FILE_TOO_LARGE", status: 413 });
  });

  it("reports network failures as an unreachable worker", async () => {
    const pending = xhrClient().upload({ file: audioFile(), title: "x", ownershipConfirmed: true });
    FakeXhr.last.onerror?.();
    expect((await errorFrom(pending)).code).toBe("UNREACHABLE");
  });

  it("can be aborted", async () => {
    const controller = new AbortController();
    const pending = xhrClient().upload({
      file: audioFile(),
      title: "x",
      ownershipConfirmed: true,
      signal: controller.signal,
    });
    controller.abort();
    expect(FakeXhr.last.aborted).toBe(true);
    expect((await errorFrom(pending)).code).toBe("ABORTED");
  });

  it("rejects a 201 whose job doesn't validate", async () => {
    const pending = xhrClient().upload({ file: audioFile(), title: "x", ownershipConfirmed: true });
    FakeXhr.last.respond(201, { job: { id: "nope" } });
    expect((await errorFrom(pending)).code).toBe("INVALID_RESPONSE");
  });
});

describe("HttpWorkerClient — translation (1.8)", () => {
  const EP = "ep-0123456789ab";
  const FP = "a".repeat(64);
  const translation = {
    schemaVersion: "1.8",
    episodeId: EP,
    segmentId: "seg-0001",
    fingerprint: FP,
    provider: "deepl",
    targetLanguage: "EN-US",
    text: "Invented English.",
    source: "provider",
    createdAt: "2026-10-07T12:00:00.000Z",
  };

  it("sends exactly one line in the approved request shape", async () => {
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      json(translation),
    );
    const client = new HttpWorkerClient(BASE, { fetchImpl });
    const result = await client.translateLine({
      episodeId: EP,
      segmentId: "seg-0001",
      text: "好的。",
    });
    expect(result.text).toBe("Invented English.");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BASE}/translations`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      episodeId: EP,
      segmentId: "seg-0001",
      text: "好的。",
    });
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("refuses a translation for another line or a malformed one", async () => {
    for (const body of [
      { ...translation, segmentId: "seg-0002" },
      { ...translation, text: "" },
    ]) {
      const client = new HttpWorkerClient(BASE, { fetchImpl: async () => json(body) });
      const error = await errorFrom(
        client.translateLine({ episodeId: EP, segmentId: "seg-0001", text: "好的。" }),
      );
      expect(error.code).toBe("INVALID_RESPONSE");
    }
  });

  it("keeps the worker's fixed error code", async () => {
    const client = new HttpWorkerClient(BASE, {
      fetchImpl: async () =>
        json({ error: { code: "TRANSLATION_LOCAL_LIMIT", message: "limit" } }, 429),
    });
    const error = await errorFrom(
      client.translateLine({ episodeId: EP, segmentId: "seg-0001", text: "好的。" }),
    );
    expect(error).toMatchObject({ code: "TRANSLATION_LOCAL_LIMIT", status: 429 });
  });

  it("reads cached English with a GET only, for local episode ids only", async () => {
    const cached = {
      schemaVersion: "1.8",
      episodeId: EP,
      provider: "deepl",
      targetLanguage: "EN-US",
      cacheVersion: 1,
      translations: [],
    };
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      json(cached),
    );
    const client = new HttpWorkerClient(BASE, { fetchImpl });
    expect((await client.getEpisodeTranslations(EP)).translations).toEqual([]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BASE}/episodes/${EP}/translations`);
    expect(init?.method).toBeUndefined();
    expect(init?.body).toBeUndefined();
    await errorFrom(client.getEpisodeTranslations("../health"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const other = new HttpWorkerClient(BASE, {
      fetchImpl: async () => json({ ...cached, episodeId: "ep-ffffffffffff" }),
    });
    expect((await errorFrom(other.getEpisodeTranslations(EP))).code).toBe("INVALID_RESPONSE");
  });

  it("grants consent with the given version only", async () => {
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      json({
        schemaVersion: "1.8",
        provider: "deepl",
        status: "current",
        consentVersion: "deepl-2026-10",
        grantedAt: "2026-10-07T12:00:00.000Z",
      }),
    );
    const client = new HttpWorkerClient(BASE, { fetchImpl });
    expect((await client.grantTranslationConsent("deepl-2026-10")).status).toBe("current");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BASE}/translation/consent`);
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(init?.body as string)).toEqual({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      provider: "deepl",
      consentVersion: "deepl-2026-10",
    });
  });
});

describe("HttpWorkerClient — speakers (1.9)", () => {
  const EP = "ep-0123456789ab";
  const RUN = "spk-0123456789ab";
  const speakers = (episodeId = EP, runId: string | null = RUN) => ({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    episodeId,
    current:
      runId === null
        ? null
        : {
            runId,
            completedAt: "2026-10-07T12:00:00.000Z",
            provenance: {
              modelId: "invented/model",
              modelRevision: "v0",
              speakerCountHint: null,
              clustering: "fake",
              windows: 3,
              noiseWindows: 0,
              unassignedLines: 0,
            },
            speakers: [{ id: "S1", lines: 1, windows: 3 }],
            assignments: { "seg-0001": "S1" },
            corrections: null,
            effective: { "seg-0001": "S1" },
          },
    latest: {
      runId: RUN,
      status: "queued",
      failure: null,
      createdAt: "2026-10-07T12:00:00.000Z",
      updatedAt: "2026-10-07T12:00:00.000Z",
    },
  });
  const fetching = (body: unknown) =>
    vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => json(body));

  it("reads, starts (with an optional hint) and cancels a specific run", async () => {
    const fetchImpl = fetching(speakers());
    const client = new HttpWorkerClient(BASE, { fetchImpl });
    await client.getEpisodeSpeakers(EP);
    await client.startSpeakerDetection(EP, null);
    await client.startSpeakerDetection(EP, 2);
    await client.cancelSpeakerRun(EP, RUN);
    const calls = fetchImpl.mock.calls.map(([url, init]) => [
      url,
      init?.method ?? "GET",
      init?.body,
    ]);
    expect(calls).toEqual([
      [`${BASE}/episodes/${EP}/speakers`, "GET", undefined],
      [
        `${BASE}/episodes/${EP}/speakers`,
        "POST",
        JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION }),
      ],
      [
        `${BASE}/episodes/${EP}/speakers`,
        "POST",
        JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, speakerCount: 2 }),
      ],
      [`${BASE}/episodes/${EP}/speakers/runs/${RUN}/cancel`, "POST", undefined],
    ]);
  });

  it("rejects another episode's speakers and corrections saved to another run", async () => {
    const other = new HttpWorkerClient(BASE, { fetchImpl: fetching(speakers("ep-ffffffffffff")) });
    expect((await errorFrom(other.getEpisodeSpeakers(EP))).code).toBe("INVALID_RESPONSE");
    const replaced = new HttpWorkerClient(BASE, {
      fetchImpl: fetching(speakers(EP, "spk-ffffffffffff")),
    });
    const request = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      episodeId: EP,
      runId: RUN,
      revision: 0,
      names: {},
      merges: {},
      notSpeaker: [],
      lines: {},
    };
    expect((await errorFrom(replaced.saveSpeakerCorrections(request))).code).toBe(
      "INVALID_RESPONSE",
    );
  });

  it("never sends an invalid episode or run id", async () => {
    const fetchImpl = fetching(speakers());
    const client = new HttpWorkerClient(BASE, { fetchImpl });
    expect((await errorFrom(client.getEpisodeSpeakers("../x"))).code).toBe("NOT_FOUND");
    expect((await errorFrom(client.cancelSpeakerRun(EP, "spk-../../x"))).code).toBe("NOT_FOUND");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
