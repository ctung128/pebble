import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import {
  CURRENT_SCHEMA_VERSION,
  parseWorkerHealth,
  type EpisodeSpeakers,
  type SpeakerHealth,
  type TranslationHealth,
  type Transcript,
} from "@pebble/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpisodeSource, ResolvedEpisode } from "../../data/EpisodeSource.ts";
import { SourceProvider } from "../../data/SourceContext.tsx";
import { EpisodePage } from "../../features/episode/EpisodePage.tsx";
import { LearningProvider } from "../../features/learning/LearningContext.tsx";
import { MemoryLearningStore } from "../../features/learning/MemoryLearningStore.ts";
import { TranslationProviderContext } from "../../features/translation/TranslationContext.tsx";
import { SessionCachedTranslationProvider } from "../../features/translation/TranslationProvider.ts";
import { fakeTranslationProvider, testEpisode } from "../../test/fixtures.tsx";
import { fakeWorkerClient, funasrHealth } from "../../test/localFixtures.tsx";
import { LocalTranslationProvider } from "../LocalTranslationProvider.tsx";
import { WorkerError, type WorkerClient } from "../workerClient.ts";
import { WorkerProvider } from "../WorkerContext.tsx";
import { LocalSpeakersProvider } from "./LocalSpeakersProvider.tsx";
import {
  SPEAKER_CONFLICT_ACTIONS,
  SPEAKER_CONFLICT_CHOOSE,
  SPEAKER_CONFLICT_COMBINED,
  SPEAKER_CONFLICT_KEPT,
  SPEAKER_NOT_CARRIED,
  SPEAKER_STATUS,
  SPEAKER_UNAVAILABLE,
  SPEAKERS,
} from "./speakerCopy.ts";
import { POLLING } from "./useEpisodeSpeakers.ts";

// --- Invented data -------------------------------------------------------------------------

const EP_A = "ep-aaaaaaaaaaaa";
const EP_B = "ep-bbbbbbbbbbbb";
const RUN_1 = "spk-111111111111";
const RUN_2 = "spk-222222222222";
const LINES = ["今天天气很好，", "我们一起去公园。", "好的。"];
const NAME = "Invented Host";
const STAMP = "2026-10-07T12:00:00.000Z";

function transcript(episodeId: string, kind: "asr" | "mock" = "asr"): Transcript {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    episodeId,
    language: "zh-CN",
    script: "simplified",
    durationMs: 9000,
    segments: LINES.map((text, i) => ({
      id: `seg-000${i + 1}`,
      index: i,
      startMs: i * 3000,
      endMs: i * 3000 + 2500,
      text,
      speaker: null,
      confidence: null,
      tokens: null,
    })),
    provenance: {
      kind,
      provider: kind === "asr" ? "funasr" : "mock",
      model: null,
      createdAt: STAMP,
    },
  };
}

function source(kind: "asr" | "mock" = "asr"): EpisodeSource {
  return {
    mode: "local",
    listEpisodes: async () => [],
    getEpisode: async (id): Promise<ResolvedEpisode> => ({
      ...testEpisode,
      id,
      title: id === EP_A ? "Episode A" : "Episode B",
      demo: undefined,
      audioProvenance: { kind: "user-provided", publishable: false, notes: "Yours." },
      audioUrl: `http://127.0.0.1:8790/episodes/${id}/audio`,
    }),
    getTranscript: async (id) => transcript(id, kind),
    getReviewHints: async () => [],
  };
}

type Status = "queued" | "running" | "completed" | "failed" | "cancelled";

function payload(
  episodeId: string,
  options: {
    run?: string;
    assignments?: (string | null)[];
    corrections?: Partial<NonNullable<NonNullable<EpisodeSpeakers["current"]>["corrections"]>>;
    latest?: { run: string; status: Status; code?: string } | null;
  } = {},
): EpisodeSpeakers {
  const run = options.run ?? RUN_1;
  const assignments = options.assignments;
  const current = assignments
    ? {
        runId: run,
        completedAt: STAMP,
        provenance: {
          modelId: "invented/model",
          modelRevision: "v0",
          speakerCountHint: null,
          clustering: "fake",
          windows: 9,
          noiseWindows: 0,
          unassignedLines: assignments.filter((a) => a === null).length,
        },
        speakers: [...new Set(assignments.filter((a): a is string => a !== null))]
          .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
          .map((id) => ({ id, lines: assignments.filter((a) => a === id).length, windows: 3 })),
        assignments: Object.fromEntries(assignments.map((s, i) => [`seg-000${i + 1}`, s])),
        corrections: options.corrections
          ? {
              names: {},
              merges: {},
              notSpeaker: [],
              lines: {},
              revision: 1,
              updatedAt: STAMP,
              ...options.corrections,
            }
          : null,
        effective: Object.fromEntries(assignments.map((s, i) => [`seg-000${i + 1}`, s])),
      }
    : null;
  const latest =
    options.latest === null
      ? null
      : options.latest
        ? {
            runId: options.latest.run,
            status: options.latest.status,
            failure:
              options.latest.status === "failed" || options.latest.status === "cancelled"
                ? {
                    code: (options.latest.code ?? "TIMED_OUT") as never,
                    message: "fixed",
                    retryable: true,
                  }
                : null,
            createdAt: STAMP,
            updatedAt: STAMP,
          }
        : current
          ? {
              runId: run,
              status: "completed" as const,
              failure: null,
              createdAt: STAMP,
              updatedAt: STAMP,
            }
          : null;
  return { schemaVersion: CURRENT_SCHEMA_VERSION, episodeId, current, latest };
}

const READY: SpeakerHealth = { state: "ready", hint: null };

function translationHealth(): TranslationHealth {
  return {
    provider: "deepl",
    configured: true,
    consent: "current",
    consentVersion: "deepl-2026-10",
    newRequests: "available",
    limits: {
      period: "2026-10",
      requestsUsed: 0,
      requestLimit: 300,
      charactersUsed: 0,
      characterLimit: 30000,
    },
  };
}

function client(
  speakers: SpeakerHealth | undefined,
  overrides: Partial<WorkerClient> = {},
  extra: { translation?: TranslationHealth } = {},
) {
  const health = {
    ...funasrHealth(),
    ...(speakers ? { speakers } : {}),
    ...(extra.translation ? { translation: extra.translation } : {}),
  };
  return fakeWorkerClient({ health: vi.fn(async () => parseWorkerHealth(health)), ...overrides });
}

// --- Rendering -----------------------------------------------------------------------------

function Tree({
  worker,
  episodeId,
  kind,
  local = true,
  store,
}: {
  worker: WorkerClient;
  episodeId: string;
  kind: "asr" | "mock";
  local?: boolean;
  store: MemoryLearningStore;
}) {
  const page = (
    <SourceProvider source={source(kind)}>
      <TranslationProviderContext
        provider={new SessionCachedTranslationProvider(fakeTranslationProvider().provider)}
      >
        <LearningProvider openStore={() => Promise.resolve(store)}>
          <MemoryRouter>
            <EpisodePage key={episodeId} episodeId={episodeId} />
          </MemoryRouter>
        </LearningProvider>
      </TranslationProviderContext>
    </SourceProvider>
  );
  return (
    <WorkerProvider client={worker}>
      <LocalTranslationProvider>
        {local ? <LocalSpeakersProvider>{page}</LocalSpeakersProvider> : page}
      </LocalTranslationProvider>
    </WorkerProvider>
  );
}

function renderEpisode(
  worker: WorkerClient,
  options: { episodeId?: string; kind?: "asr" | "mock"; local?: boolean } = {},
) {
  const kind = options.kind ?? "asr";
  const local = options.local ?? true;
  const store = new MemoryLearningStore();
  const view = render(
    <Tree
      worker={worker}
      episodeId={options.episodeId ?? EP_A}
      kind={kind}
      local={local}
      store={store}
    />,
  );
  return {
    ...view,
    store,
    navigate: (episodeId: string) =>
      view.rerender(
        <Tree worker={worker} episodeId={episodeId} kind={kind} local={local} store={store} />,
      ),
  };
}

async function transcriptLoaded() {
  const list = await screen.findByRole("list", { name: "Transcript" });
  await within(list).findAllByRole("button", { name: /^\d+:\d\d/ });
  return list;
}

const lineButton = (list: HTMLElement, n: number) =>
  within(list).getByRole("button", { name: new RegExp(`^0:0${n * 3}`) });

const panel = () => screen.findByRole("region", { name: SPEAKERS.heading });

async function openFromMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Transcript actions" }));
  await user.click(await screen.findByRole("menuitem", { name: SPEAKERS.showPanel }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Polling at test speed (real timers): 20 ms between polls instead of seconds.
const REAL_POLLING = { ...POLLING };
beforeEach(() => {
  POLLING.delaysMs = [20, 20, 20, 20];
});
afterEach(() => {
  POLLING.delaysMs = REAL_POLLING.delaysMs;
  POLLING.maxPolls = REAL_POLLING.maxPolls;
  vi.restoreAllMocks();
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

/** A worker whose reads reflect a started run, as the real worker's do (polling can't undo it). */
function startable(start?: () => Promise<EpisodeSpeakers>) {
  let state = payload(EP_A, { latest: null });
  return client(READY, {
    getEpisodeSpeakers: vi.fn(async () => state),
    startSpeakerDetection: vi.fn(async (id: string) => {
      state = start ? await start() : payload(id, { latest: { run: RUN_1, status: "queued" } });
      return state;
    }),
  });
}

// --- Capability and demo isolation -----------------------------------------------------------

describe("speaker capability gating", () => {
  it("shows nothing and asks nothing when health has no speakers block (older worker)", async () => {
    const worker = client(undefined);
    renderEpisode(worker);
    await transcriptLoaded();
    await act(async () => undefined);
    expect(screen.queryByRole("region", { name: SPEAKERS.heading })).toBeNull();
    expect(worker.getEpisodeSpeakers).not.toHaveBeenCalled();
  });

  it("never asks from the demo tree (no local provider)", async () => {
    const worker = client(READY);
    renderEpisode(worker, { local: false });
    await transcriptLoaded();
    await act(async () => undefined);
    expect(screen.queryByRole("region", { name: SPEAKERS.heading })).toBeNull();
    expect(worker.getEpisodeSpeakers).not.toHaveBeenCalled();
  });

  it("keeps mock transcripts out of it", async () => {
    const worker = client(READY);
    renderEpisode(worker, { kind: "mock" });
    await transcriptLoaded();
    await act(async () => undefined);
    expect(worker.getEpisodeSpeakers).not.toHaveBeenCalled();
  });

  it("reads once when shown, with the capability, and makes no other request", async () => {
    const worker = client(READY);
    renderEpisode(worker);
    expect(await panel()).toBeTruthy();
    await waitFor(() => expect(worker.getEpisodeSpeakers).toHaveBeenCalledTimes(1));
    expect(worker.getEpisodeSpeakers).toHaveBeenCalledWith(EP_A);
    expect(worker.startSpeakerDetection).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: SPEAKERS.detect })).toBeTruthy();
    expect(screen.queryByText("No speakers detected yet.")).toBeNull();
  });

  it.each(["model_missing", "isolation_unavailable"] as const)(
    "keeps labels readable but offers no detection when %s",
    async (state) => {
      const worker = client(
        { state, hint: null },
        {
          getEpisodeSpeakers: vi.fn(async (id: string) =>
            payload(id, { assignments: ["S1", "S2", "S1"] }),
          ),
        },
      );
      renderEpisode(worker);
      const list = await transcriptLoaded();
      await waitFor(() => expect(lineButton(list, 1).textContent).toMatch(/Speaker\s*B/));
      expect(lineButton(list, 0).textContent).toMatch(/Speaker\s*A/);
      const region = await panel();
      expect(within(region).getByText(new RegExp(SPEAKER_UNAVAILABLE.keepReadable))).toBeTruthy();
      expect(within(region).queryByRole("button", { name: /Detect speakers/ })).toBeNull();
      expect(within(region).getByRole("list", { name: SPEAKERS.keyHeading })).toBeTruthy();
    },
  );
});

// --- Detection --------------------------------------------------------------------------------

describe("detection", () => {
  it("starts only on an explicit click, once, even when clicked repeatedly", async () => {
    const started = deferred<EpisodeSpeakers>();
    const worker = startable(() => started.promise);
    renderEpisode(worker);
    const region = await panel();
    const detect = await within(region).findByRole("button", { name: SPEAKERS.detect });
    expect(worker.startSpeakerDetection).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.click(detect);
    await user.click(within(region).getByRole("button", { name: SPEAKERS.starting }));
    await user.dblClick(within(region).getByRole("button", { name: SPEAKERS.starting }));
    expect(worker.startSpeakerDetection).toHaveBeenCalledTimes(1);
    expect(worker.startSpeakerDetection).toHaveBeenCalledWith(EP_A, null);
    await act(async () =>
      started.resolve(payload(EP_A, { latest: { run: RUN_1, status: "queued" } })),
    );
    expect(within(region).getByRole("status").textContent).toContain(SPEAKER_STATUS.queued);
    expect(within(region).queryByRole("button", { name: SPEAKERS.detect })).toBeNull();
  });

  it("sends an optional count hint only when given, and refuses an invalid one", async () => {
    const worker = startable();
    renderEpisode(worker);
    const region = await panel();
    const user = userEvent.setup();
    await user.click(within(region).getByText(SPEAKERS.advanced));
    const hint = within(region).getByLabelText(SPEAKERS.hintLabel);
    await user.type(hint, "20");
    expect(within(region).getByRole("button", { name: SPEAKERS.detect })).toHaveProperty(
      "disabled",
      true,
    );
    await user.clear(hint);
    await user.type(hint, "2");
    await user.click(within(region).getByRole("button", { name: SPEAKERS.detect }));
    expect(worker.startSpeakerDetection).toHaveBeenCalledWith(EP_A, 2);
  });

  it("cancels exactly the run on screen", async () => {
    // Like the worker: once cancelled, reads report the cancellation too.
    let state = payload(EP_A, { latest: { run: RUN_2, status: "running" } });
    const worker = client(READY, {
      getEpisodeSpeakers: vi.fn(async () => state),
      cancelSpeakerRun: vi.fn(async (id: string) => {
        state = payload(id, { latest: { run: RUN_2, status: "cancelled", code: "CANCELLED" } });
        return state;
      }),
    });
    renderEpisode(worker);
    const region = await panel();
    const user = userEvent.setup();
    await user.click(await within(region).findByRole("button", { name: SPEAKERS.cancel }));
    expect(worker.cancelSpeakerRun).toHaveBeenCalledWith(EP_A, RUN_2);
    await waitFor(() =>
      expect(within(region).getByRole("status").textContent).toContain(SPEAKER_STATUS.cancelled),
    );
  });

  it("keeps the previous result visible while re-detecting and after a failure", async () => {
    let state = payload(EP_A, {
      assignments: ["S1", "S2", "S1"],
      latest: { run: RUN_2, status: "running" },
    });
    const worker = client(READY, { getEpisodeSpeakers: vi.fn(async () => state) });
    renderEpisode(worker);
    const list = await transcriptLoaded();
    await waitFor(() => expect(lineButton(list, 1).textContent).toMatch(/Speaker\s*B/));
    const region = await panel();
    expect(within(region).getByRole("status").textContent).toContain(SPEAKER_STATUS.running);
    state = payload(EP_A, {
      assignments: ["S1", "S2", "S1"],
      latest: { run: RUN_2, status: "failed", code: "TIMED_OUT" },
    });
    await waitFor(() =>
      expect(within(region).getByRole("status").textContent).toMatch(/took too long/),
    );
    expect(lineButton(list, 1).textContent).toMatch(/Speaker\s*B/);
    expect(within(region).getByRole("button", { name: SPEAKERS.detectAgain })).toBeTruthy();
  });
});

describe("polling", () => {
  it("polls only while a run is active, and stops on completion and on unmount", async () => {
    let state = payload(EP_A, { latest: { run: RUN_1, status: "queued" } });
    const get = vi.fn(async () => state);
    const worker = client(READY, { getEpisodeSpeakers: get });
    const view = renderEpisode(worker);
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThanOrEqual(3)); // polling
    state = payload(EP_A, { assignments: ["S1", "S1", "S2"] });
    const region = await panel();
    await waitFor(() =>
      expect(within(region).getByRole("status").textContent).toContain(SPEAKER_STATUS.done),
    );
    const settled = get.mock.calls.length;
    await wait(200);
    expect(get).toHaveBeenCalledTimes(settled); // completed: no more polling

    view.unmount();
  });

  it("stops polling when the page unmounts during an active run", async () => {
    const get = vi.fn(async (id: string) =>
      payload(id, { latest: { run: RUN_1, status: "running" } }),
    );
    const view = renderEpisode(client(READY, { getEpisodeSpeakers: get }));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThanOrEqual(3)); // polling
    view.unmount();
    const atUnmount = get.mock.calls.length;
    await wait(200);
    expect(get).toHaveBeenCalledTimes(atUnmount);
  });

  it("stops after the poll limit and offers Check again", async () => {
    POLLING.maxPolls = 2;
    const get = vi.fn(async (id: string) =>
      payload(id, { latest: { run: RUN_1, status: "running" } }),
    );
    renderEpisode(client(READY, { getEpisodeSpeakers: get }));
    const region = await panel();
    const again = await within(region).findByRole("button", { name: SPEAKERS.checkAgain });
    expect(get).toHaveBeenCalledTimes(3); // the first read and two polls
    expect(within(region).getByRole("status").textContent).toContain(SPEAKER_STATUS.pollStopped);
    await userEvent.setup().click(again);
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(3));
  });

  it("ignores a late response for an episode that is no longer shown", async () => {
    const slowA = deferred<EpisodeSpeakers>();
    const get = vi.fn((id: string) =>
      id === EP_A
        ? slowA.promise
        : Promise.resolve(payload(id, { assignments: ["S1", "S1", "S1"] })),
    );
    const worker = client(READY, { getEpisodeSpeakers: get });
    const view = renderEpisode(worker);
    await transcriptLoaded();
    view.navigate(EP_B);
    const list = await transcriptLoaded();
    await waitFor(() => expect(lineButton(list, 1).textContent).toMatch(/Speaker\s*A/));
    await act(async () => slowA.resolve(payload(EP_A, { assignments: ["S2", "S2", "S2"] })));
    expect(lineButton(list, 1).textContent).toMatch(/Speaker\s*A/);
    expect(lineButton(list, 1).textContent).not.toMatch(/Speaker\s*B/);
  });
});

// --- Corrections ------------------------------------------------------------------------------

function correctable(extra: Partial<WorkerClient> = {}, initial?: EpisodeSpeakers) {
  let state = initial ?? payload(EP_A, { assignments: ["S1", "S2", "S3"] });
  const worker = client(READY, {
    getEpisodeSpeakers: vi.fn(async () => state),
    saveSpeakerCorrections: vi.fn(async (request) => {
      state = payload(EP_A, {
        assignments: ["S1", "S2", "S3"],
        corrections: { ...request, revision: request.revision + 1 },
      });
      return state;
    }),
    ...extra,
  });
  return { worker, set: (next: EpisodeSpeakers) => (state = next) };
}

describe("corrections", () => {
  it("renames, merges with confirmation, hides a cluster and reassigns lines, then saves", async () => {
    const { worker } = correctable();
    renderEpisode(worker);
    const list = await transcriptLoaded();
    const region = await panel();
    await waitFor(() => expect(lineButton(list, 2).textContent).toMatch(/Speaker\s*C/));
    const user = userEvent.setup();

    await user.type(within(region).getByLabelText(SPEAKERS.nameLabel("A")), NAME);

    // Merge B into A from B's menu, with a confirmation step.
    const actionsB = within(region).getByRole("button", { name: SPEAKERS.actionsLabel("B") });
    const tileB = within(actionsB.closest("li") as HTMLElement);
    await user.click(actionsB);
    await user.click(await screen.findByRole("menuitem", { name: SPEAKERS.mergeInto("A", NAME) }));
    expect(lineButton(list, 1).textContent).toMatch(/Speaker\s*B/); // not yet
    await user.click(tileB.getByRole("button", { name: SPEAKERS.mergeConfirm }));
    expect(lineButton(list, 1).textContent).toMatch(/Speaker\s*A/);
    // B's tile now says what happened, with a way back.
    expect(
      within(region).getByRole("button", {
        name: SPEAKERS.undoLabel(SPEAKERS.mergedRow("B", "A")),
      }),
    ).toBeTruthy();

    // Mark C as not a speaker from its menu: its line shows no letter.
    await user.click(within(region).getByRole("button", { name: SPEAKERS.actionsLabel("C") }));
    await user.click(await screen.findByRole("menuitem", { name: SPEAKERS.notSpeaker }));
    expect(lineButton(list, 2).textContent).not.toMatch(/Speaker\s*[A-Z]/);

    // Per-line: reassign the first line to not-a-speaker, then back.
    await user.click(within(region).getByRole("button", { name: SPEAKERS.correctLines }));
    const select = await screen.findByRole("combobox", { name: SPEAKERS.lineSelectLabel("0:00") });
    await user.selectOptions(select, "none");
    expect(lineButton(list, 0).textContent).not.toMatch(/Speaker\s*[A-Z]/);
    await user.selectOptions(select, "auto");
    expect(lineButton(list, 0).textContent).toMatch(/Speaker\s*A/);
    await user.selectOptions(select, "none");

    await user.click(within(region).getByRole("button", { name: SPEAKERS.save }));
    expect(worker.saveSpeakerCorrections).toHaveBeenCalledWith({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      episodeId: EP_A,
      runId: RUN_1,
      revision: 0,
      names: { S1: NAME },
      merges: { S2: "S1" },
      notSpeaker: ["S3"],
      lines: { "seg-0001": null },
    });
    // Saved: the panel is tucked into the transcript actions menu, and that is announced.
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: SPEAKERS.heading })).toBeNull(),
    );
    expect(screen.getByText(SPEAKERS.savedTucked)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Transcript actions" }));
  });

  /** A worker whose first save is refused because `elsewhere` was saved meanwhile. */
  function conflicted(elsewhere: EpisodeSpeakers) {
    const save = vi.fn();
    const { worker, set } = correctable({ saveSpeakerCorrections: save });
    save.mockImplementationOnce(async () => {
      set(elsewhere);
      throw new WorkerError("SPEAKER_CORRECTIONS_STALE", "worker text", { status: 409 });
    });
    save.mockImplementation(async (request) =>
      payload(EP_A, {
        assignments: ["S1", "S2", "S3"],
        corrections: { ...request, revision: request.revision + 1 },
      }),
    );
    return worker;
  }

  const nameField = (region: HTMLElement, letter: string) =>
    within(region).getByLabelText(SPEAKERS.nameLabel(letter)) as HTMLInputElement;

  it("combines non-clashing edits from elsewhere with mine, and still waits for Save", async () => {
    const worker = conflicted(
      payload(EP_A, {
        assignments: ["S1", "S2", "S3"],
        corrections: { names: { S2: "Set elsewhere" }, notSpeaker: ["S3"], revision: 1 },
      }),
    );
    renderEpisode(worker);
    const region = await panel();
    const user = userEvent.setup();
    await user.type(await within(region).findByLabelText(SPEAKERS.nameLabel("A")), NAME);
    await user.click(within(region).getByRole("button", { name: SPEAKERS.save }));
    await waitFor(() =>
      expect(within(region).getByRole("status").textContent).toContain(SPEAKER_CONFLICT_COMBINED),
    );
    expect(worker.saveSpeakerCorrections).toHaveBeenCalledTimes(1); // nothing saved silently
    expect(nameField(region, "A").value).toBe(NAME);
    expect(nameField(region, "B").value).toBe("Set elsewhere");
    expect(screen.queryByText("worker text")).toBeNull();
    await user.click(within(region).getByRole("button", { name: SPEAKERS.save }));
    expect(worker.saveSpeakerCorrections).toHaveBeenLastCalledWith(
      expect.objectContaining({
        revision: 1,
        runId: RUN_1,
        names: { S1: NAME, S2: "Set elsewhere" },
        notSpeaker: ["S3"],
      }),
    );
  });

  it("on a clash asks for an explicit choice and saves mine only after it", async () => {
    const worker = conflicted(
      payload(EP_A, {
        assignments: ["S1", "S2", "S3"],
        // S1 clashes with my edit; S3 is a change I didn't touch.
        corrections: { names: { S1: "Other name" }, notSpeaker: ["S3"], revision: 1 },
      }),
    );
    renderEpisode(worker);
    const region = await panel();
    const user = userEvent.setup();
    await user.type(await within(region).findByLabelText(SPEAKERS.nameLabel("A")), NAME);
    await user.click(within(region).getByRole("button", { name: SPEAKERS.save }));
    await waitFor(() =>
      expect(within(region).getByRole("status").textContent).toContain(SPEAKER_CONFLICT_CHOOSE(1)),
    );
    expect(nameField(region, "A").value).toBe(NAME); // my draft is kept
    expect(within(region).getByRole("button", { name: SPEAKERS.save })).toHaveProperty(
      "disabled",
      true,
    );
    await user.click(
      within(region).getByRole("button", { name: SPEAKER_CONFLICT_ACTIONS.keepMine }),
    );
    expect(within(region).getByRole("status").textContent).toContain(SPEAKER_CONFLICT_KEPT);
    expect(worker.saveSpeakerCorrections).toHaveBeenCalledTimes(1);
    await user.click(within(region).getByRole("button", { name: SPEAKERS.save }));
    // As the copy says: my whole set replaces the saved one, including the non-clashing change.
    expect(worker.saveSpeakerCorrections).toHaveBeenLastCalledWith(
      expect.objectContaining({ revision: 1, names: { S1: NAME }, notSpeaker: [] }),
    );
  });

  it("on a clash can take the saved version instead", async () => {
    const worker = conflicted(
      payload(EP_A, {
        assignments: ["S1", "S2", "S3"],
        corrections: { names: { S1: "Other name" }, revision: 1 },
      }),
    );
    renderEpisode(worker);
    const region = await panel();
    const user = userEvent.setup();
    await user.type(await within(region).findByLabelText(SPEAKERS.nameLabel("A")), NAME);
    await user.click(within(region).getByRole("button", { name: SPEAKERS.save }));
    await user.click(
      await within(region).findByRole("button", { name: SPEAKER_CONFLICT_ACTIONS.useSaved }),
    );
    expect(nameField(region, "A").value).toBe("Other name");
    expect(worker.saveSpeakerCorrections).toHaveBeenCalledTimes(1);
  });

  it("explains that a new detection didn't carry the earlier corrections over", async () => {
    let state = payload(EP_A, {
      assignments: ["S1", "S2", "S1"],
      corrections: { names: { S1: NAME } },
      latest: { run: RUN_2, status: "running" },
    });
    const worker = client(READY, { getEpisodeSpeakers: vi.fn(async () => state) });
    renderEpisode(worker);
    const region = await panel();
    await waitFor(() =>
      expect(
        (within(region).getByLabelText(SPEAKERS.nameLabel("A")) as HTMLInputElement).value,
      ).toBe(NAME),
    );
    state = payload(EP_A, { run: RUN_2, assignments: ["S1", "S1", "S2"] });
    await waitFor(() =>
      expect(within(region).getByRole("status").textContent).toContain(SPEAKER_NOT_CARRIED),
    );
    expect((within(region).getByLabelText(SPEAKERS.nameLabel("A")) as HTMLInputElement).value).toBe(
      "",
    );
  });
});

describe("tucking the panel into the menu", () => {
  const savedPayload = (id: string, latest?: { run: string; status: Status }) =>
    payload(id, { assignments: ["S1", "S2", "S1"], corrections: { names: { S1: NAME } }, latest });

  it("opens tucked away when corrections are saved, with letters still on the lines", async () => {
    const worker = client(READY, {
      getEpisodeSpeakers: vi.fn(async (id: string) => savedPayload(id)),
    });
    renderEpisode(worker);
    const list = await transcriptLoaded();
    await waitFor(() => expect(lineButton(list, 1).textContent).toMatch(/Speaker\s*B/));
    expect(screen.queryByRole("region", { name: SPEAKERS.heading })).toBeNull();
  });

  it("reopens from the menu with focus on its heading, and hides again by button or menu", async () => {
    const worker = client(READY, {
      getEpisodeSpeakers: vi.fn(async (id: string) => savedPayload(id)),
    });
    renderEpisode(worker);
    await transcriptLoaded();
    const user = userEvent.setup();
    await openFromMenu(user);
    const region = await panel();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(region).getByRole("heading", { name: SPEAKERS.heading }),
      ),
    );
    await user.click(within(region).getByRole("button", { name: SPEAKERS.hidePanel }));
    expect(screen.queryByRole("region", { name: SPEAKERS.heading })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Transcript actions" }));
    await openFromMenu(user);
    await panel();
    await user.click(screen.getByRole("button", { name: "Transcript actions" }));
    await user.click(await screen.findByRole("menuitem", { name: SPEAKERS.hidePanel }));
    expect(screen.queryByRole("region", { name: SPEAKERS.heading })).toBeNull();
  });

  it("opens while a run is active, and can be hidden and reopened before anything is saved", async () => {
    const worker = client(READY, {
      getEpisodeSpeakers: vi.fn(async (id: string) =>
        savedPayload(id, { run: RUN_2, status: "running" }),
      ),
    });
    renderEpisode(worker);
    expect(await panel()).toBeTruthy();

    const fresh = client(READY, {
      getEpisodeSpeakers: vi.fn(async (id: string) =>
        payload(id, { assignments: ["S1", "S2", "S1"] }),
      ),
    });
    const second = renderEpisode(fresh, { episodeId: EP_B });
    await within(second.container).findByRole("region", { name: SPEAKERS.heading });
    const user = userEvent.setup();
    const region = within(second.container).getByRole("region", { name: SPEAKERS.heading });
    await user.click(within(region).getByRole("button", { name: SPEAKERS.hidePanel }));
    expect(within(second.container).queryByRole("region", { name: SPEAKERS.heading })).toBeNull();
    await user.click(within(second.container).getByRole("button", { name: "Transcript actions" }));
    await user.click(await screen.findByRole("menuitem", { name: SPEAKERS.showPanel }));
    await within(second.container).findByRole("region", { name: SPEAKERS.heading });
  });
});

// --- Privacy and accessibility ----------------------------------------------------------------

describe("privacy and accessibility", () => {
  it("logs nothing (no names or payloads) while detecting and correcting", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    const { worker } = correctable();
    renderEpisode(worker);
    const region = await panel();
    const user = userEvent.setup();
    await user.type(await within(region).findByLabelText(SPEAKERS.nameLabel("A")), NAME);
    await user.click(within(region).getByRole("button", { name: SPEAKERS.save }));
    await waitFor(() => expect(worker.saveSpeakerCorrections).toHaveBeenCalled());
    for (const spy of spies) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(NAME);
    }
  });

  it("never sends a speaker letter or name with a line for English", async () => {
    const worker = client(
      READY,
      {
        getEpisodeSpeakers: vi.fn(async (id: string) =>
          payload(id, { assignments: ["S1", "S2", "S1"], corrections: { names: { S2: NAME } } }),
        ),
        translateLine: vi.fn(async ({ episodeId, segmentId }) => ({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          episodeId,
          segmentId,
          fingerprint: "a".repeat(64),
          provider: "deepl" as const,
          targetLanguage: "EN-US" as const,
          text: "Invented English.",
          source: "provider" as const,
          createdAt: STAMP,
        })),
      },
      { translation: translationHealth() },
    );
    renderEpisode(worker);
    const list = await transcriptLoaded();
    await waitFor(() => expect(lineButton(list, 1).textContent).toMatch(/Speaker\s*B/));
    const user = userEvent.setup();
    const group = screen.getByRole("group", { name: "Line at 0:03" });
    await user.click(within(group).getByRole("button", { name: "English" }));
    await waitFor(() => expect(worker.translateLine).toHaveBeenCalled());
    expect(worker.translateLine).toHaveBeenCalledWith({
      episodeId: EP_A,
      segmentId: "seg-0002",
      text: LINES[1],
    });
  });

  it("announces the letter with a confirmed name only, never in text, English or saved items", async () => {
    const worker = client(READY, {
      getEpisodeSpeakers: vi.fn(async (id: string) =>
        payload(id, { assignments: ["S1", "S2", "S1"], corrections: { names: { S2: NAME } } }),
      ),
    });
    const { store } = renderEpisode(worker);
    const list = await transcriptLoaded();
    await waitFor(() =>
      expect(lineButton(list, 1)).toHaveProperty(
        "textContent",
        expect.stringMatching(new RegExp(`Speaker\\s*B, ${NAME}`)),
      ),
    );
    expect(screen.getByRole("button", { name: new RegExp(`Speaker B, ${NAME}`) })).toBeTruthy();
    // The visible Chinese is unchanged; the name lives only in visually hidden text.
    const chinese = LINES[1] ?? "";
    expect(within(lineButton(list, 1)).getByText(chinese).textContent).toBe(chinese);
    // A saved item is the line's text only: no letter, no name.
    const user = userEvent.setup();
    const group = screen.getByRole("group", { name: "Line at 0:03" });
    await user.click(within(group).getByRole("button", { name: "Save" }));
    await waitFor(async () => expect(await store.listItems()).toHaveLength(1));
    const [item] = await store.listItems();
    expect(item?.text).toBe(chinese);
    expect(JSON.stringify(item)).not.toContain(NAME);
    // An unsaved name is not announced. (Saved corrections tuck the panel into the menu.)
    await openFromMenu(user);
    const region = await panel();
    await user.type(within(region).getByLabelText(SPEAKERS.nameLabel("A")), "Draft");
    expect(lineButton(list, 0).textContent).not.toContain("Draft");
  });

  it("announces status politely and keeps every control reachable by keyboard", async () => {
    const worker = startable();
    renderEpisode(worker);
    const region = await panel();
    const status = within(region).getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    const detect = await within(region).findByRole("button", { name: SPEAKERS.detect });
    detect.focus();
    const user = userEvent.setup();
    await user.keyboard("{Enter}");
    expect(worker.startSpeakerDetection).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(status.textContent).toContain(SPEAKER_STATUS.queued));
    expect(within(region).getByRole("button", { name: SPEAKERS.cancel })).toBeTruthy();
  });
});
