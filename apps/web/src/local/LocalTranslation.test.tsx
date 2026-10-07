import { readFileSync } from "node:fs";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import {
  CURRENT_SCHEMA_VERSION,
  parseWorkerHealth,
  type EpisodeTranslations,
  type TranslationHealth,
  type TranslationResult,
  type Transcript,
} from "@pebble/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter as SettingsRouter, Route, Routes } from "react-router";

const downloadText = vi.hoisted(() => vi.fn());
vi.mock("../lib/downloadText.ts", () => ({ downloadText }));
import type { EpisodeSource, ResolvedEpisode } from "../data/EpisodeSource.ts";
import { SourceProvider } from "../data/SourceContext.tsx";
import { Layout } from "../App.tsx";
import { EpisodePage } from "../features/episode/EpisodePage.tsx";
import { buildLearningItem } from "../features/learning/buildLearningItem.ts";
import { LearningItemsPage } from "../features/learning/LearningItemsPage.tsx";
import { LearningProvider } from "../features/learning/LearningContext.tsx";
import { MemoryLearningStore } from "../features/learning/MemoryLearningStore.ts";
import { TranslationProviderContext } from "../features/translation/TranslationContext.tsx";
import { SessionCachedTranslationProvider } from "../features/translation/TranslationProvider.ts";
import { fingerprintOf } from "../features/translation/workerTranslation.ts";
import { fakeTranslationProvider, renderWithProviders, testEpisode } from "../test/fixtures.tsx";
import { fakeWorkerClient, funasrHealth } from "../test/localFixtures.tsx";
import { LocalTranslationProvider } from "./LocalTranslationProvider.tsx";
import { TranslationSettingsPage } from "./TranslationSettingsPage.tsx";
import {
  ATTRIBUTION,
  CONSENT_BODY,
  CONSENT_FAILED,
  CONSENT_OUT_OF_DATE,
  CONSENT_TITLE,
  LABELS,
  SETTINGS,
  TRANSLATION_MESSAGES,
} from "./translationCopy.ts";

const STALE_LABEL = LABELS.stale;
import { WorkerError, type WorkerClient } from "./workerClient.ts";
import { WorkerProvider } from "./WorkerContext.tsx";

// --- Invented data -------------------------------------------------------------------------

const EP_A = "ep-aaaaaaaaaaaa";
const EP_B = "ep-bbbbbbbbbbbb";
const LINES = ["今天天气很好，", "我们一起去公园。", "好的。"];
const EDITED = "今天天气真好，";
const ENGLISH = ["The weather is nice today,", "Let's go to the park together.", "OK."];

function asrTranscript(episodeId: string): Transcript {
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
      chunkIndex: 0,
    })),
    provenance: {
      kind: "asr",
      provider: "funasr",
      model: null,
      createdAt: "2026-10-06T00:00:00Z",
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
    getTranscript: async (id) => {
      const transcript = asrTranscript(id);
      return kind === "mock"
        ? {
            ...transcript,
            provenance: { ...transcript.provenance, kind: "mock", provider: "mock" },
          }
        : transcript;
    },
    getReviewHints: async () => [],
  };
}

function translationHealth(overrides: Partial<TranslationHealth> = {}): TranslationHealth {
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
    ...overrides,
  };
}

function healthClient(
  translation: TranslationHealth | undefined,
  overrides: Partial<WorkerClient> = {},
) {
  const health = { ...funasrHealth(), ...(translation ? { translation } : {}) };
  return fakeWorkerClient({ health: vi.fn(async () => parseWorkerHealth(health)), ...overrides });
}

async function cachedRows(
  episodeId: string,
  rows: { segment: number; text: string; english: string; at?: string }[],
): Promise<EpisodeTranslations> {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    episodeId,
    provider: "deepl",
    targetLanguage: "EN-US",
    cacheVersion: 1,
    translations: await Promise.all(
      rows.map(async (row) => ({
        segmentId: `seg-000${row.segment + 1}`,
        fingerprint: await fingerprintOf(row.text),
        text: row.english,
        createdAt: row.at ?? "2026-10-06T12:00:00.000Z",
      })),
    ),
  };
}

async function result(episodeId: string, segment: number, text: string, english: string) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    episodeId,
    segmentId: `seg-000${segment + 1}`,
    fingerprint: await fingerprintOf(text),
    provider: "deepl",
    targetLanguage: "EN-US",
    text: english,
    source: "provider",
    createdAt: "2026-10-07T12:00:00.000Z",
  } satisfies TranslationResult;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// --- Rendering -----------------------------------------------------------------------------

function Tree({
  client,
  episodeId,
  store,
  kind,
}: {
  client: WorkerClient;
  episodeId: string;
  store: MemoryLearningStore;
  kind: "asr" | "mock";
}) {
  return (
    <WorkerProvider client={client}>
      <LocalTranslationProvider>
        <SourceProvider source={source(kind)}>
          <TranslationProviderContext
            provider={new SessionCachedTranslationProvider(fakeTranslationProvider().provider)}
          >
            <LearningProvider openStore={() => Promise.resolve(store)}>
              <MemoryRouter>
                {/* Keyed by episode, like the app's EpisodeRoute. */}
                <EpisodePage key={episodeId} episodeId={episodeId} />
              </MemoryRouter>
            </LearningProvider>
          </TranslationProviderContext>
        </SourceProvider>
      </LocalTranslationProvider>
    </WorkerProvider>
  );
}

function renderLocalEpisode(
  client: WorkerClient,
  options: { episodeId?: string; store?: MemoryLearningStore; kind?: "asr" | "mock" } = {},
) {
  const store = options.store ?? new MemoryLearningStore();
  const kind = options.kind ?? "asr";
  const view = render(
    <Tree client={client} episodeId={options.episodeId ?? EP_A} store={store} kind={kind} />,
  );
  return {
    ...view,
    store,
    navigate: (episodeId: string) =>
      view.rerender(<Tree client={client} episodeId={episodeId} store={store} kind={kind} />),
  };
}

async function line(n: number) {
  const list = await screen.findByRole("list", { name: "Transcript" });
  await within(list).findAllByRole("button", { name: /^\d+:\d\d/ });
  return within(screen.getByRole("group", { name: `Line at 0:0${n * 3}` }));
}

const englishButton = async (n: number) =>
  (await line(n)).queryByRole("button", { name: "English" });

async function settle() {
  // Let fingerprints, cache reads and health resolve.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Capability gating ---------------------------------------------------------------------

describe("local English — capability", () => {
  it("offers nothing when health has no translation block (an older worker)", async () => {
    const client = healthClient(undefined);
    renderLocalEpisode(client);
    await settle();
    expect(await englishButton(0)).toBeNull();
    expect(client.getEpisodeTranslations).not.toHaveBeenCalled();
    expect(client.translateLine).not.toHaveBeenCalled();
  });

  it("never asks a worker from the demo (no local provider)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderWithProviders(<EpisodePage episodeId="test-001" />, {
      source: {
        ...source(),
        getEpisode: source().getEpisode,
        getTranscript: async () => asrTranscript("test-001"),
      },
    });
    await screen.findByRole("list", { name: "Transcript" });
    expect(screen.queryByRole("button", { name: "English" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Transcript actions" }));
    expect(screen.queryByRole("menuitem", { name: "Show saved English" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: LABELS.settings })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps mock transcripts out of it entirely", async () => {
    const client = healthClient(translationHealth());
    renderLocalEpisode(client, { kind: "mock" });
    await settle();
    await line(0);
    expect(client.getEpisodeTranslations).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Transcript actions" }));
    expect(screen.queryByRole("menuitem", { name: "Show saved English" })).toBeNull();
  });

  it("shows cached English when new requests are off, and only for lines that have it", async () => {
    const client = healthClient(
      translationHealth({ configured: false, consent: "not_configured", newRequests: "off" }),
      {
        getEpisodeTranslations: vi.fn(async () =>
          cachedRows(EP_A, [{ segment: 0, text: LINES[0]!, english: ENGLISH[0]! }]),
        ),
      },
    );
    renderLocalEpisode(client);
    await settle();
    expect(await englishButton(1)).toBeNull(); // no cached English, nothing can be sent
    await userEvent.click((await englishButton(0))!);
    expect(await screen.findByText(ENGLISH[0]!)).toBeInTheDocument();
    expect(client.translateLine).not.toHaveBeenCalled();
  });

  it("'Show saved English' reveals current cached English only and never sends", async () => {
    const client = healthClient(translationHealth(), {
      getEpisodeTranslations: vi.fn(async () =>
        cachedRows(EP_A, [
          { segment: 0, text: LINES[0]!, english: ENGLISH[0]! },
          { segment: 1, text: "一个旧版本。", english: "An old version." },
        ]),
      ),
    });
    renderLocalEpisode(client);
    await settle();
    const menu = await screen.findByRole("button", { name: "Transcript actions" });
    await userEvent.click(menu);
    await userEvent.click(screen.getByRole("menuitem", { name: "Show saved English" }));
    expect(await screen.findByText(ENGLISH[0]!)).toBeInTheDocument();
    expect(screen.queryByText("An old version.")).toBeNull(); // not current for its line
    await userEvent.click(menu);
    expect(screen.getByRole("menuitem", { name: "Hide saved English" })).toBeInTheDocument();
    expect(client.translateLine).not.toHaveBeenCalled();
  });
});

// --- Explicit submission ---------------------------------------------------------------------

describe("local English — submitting a line", () => {
  it("sends nothing until a learner taps, then exactly one line", async () => {
    const client = healthClient(translationHealth(), {
      translateLine: vi.fn(async () => result(EP_A, 1, LINES[1]!, ENGLISH[1]!)),
    });
    renderLocalEpisode(client);
    await settle();
    await settle();
    expect(client.translateLine).not.toHaveBeenCalled();
    await userEvent.click((await englishButton(1))!);
    expect(await screen.findByText(ENGLISH[1]!)).toBeInTheDocument();
    expect(client.translateLine).toHaveBeenCalledTimes(1);
    expect(client.translateLine).toHaveBeenCalledWith({
      episodeId: EP_A,
      segmentId: "seg-0002",
      text: LINES[1],
    });
    const link = screen.getByRole("link", { name: ATTRIBUTION.text });
    expect(link).toHaveAttribute("href", ATTRIBUTION.href);
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    // Closing and reopening uses the result: no second request.
    await userEvent.click((await englishButton(1))!);
    await userEvent.click((await englishButton(1))!);
    expect(client.translateLine).toHaveBeenCalledTimes(1);
  });

  it("ignores repeated taps while a line is pending", async () => {
    const pending = deferred<TranslationResult>();
    const client = healthClient(translationHealth(), {
      translateLine: vi.fn(() => pending.promise),
    });
    renderLocalEpisode(client);
    await settle();
    const button = (await englishButton(0))!;
    await userEvent.click(button); // open + send
    expect(await screen.findByText("Loading translation…")).toBeInTheDocument();
    await userEvent.click(button); // close
    await userEvent.click(button); // reopen: still pending, nothing new
    await userEvent.keyboard("t"); // the T key on the current line (same line): close
    await userEvent.keyboard("t"); // reopen
    expect(client.translateLine).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(await result(EP_A, 0, LINES[0]!, ENGLISH[0]!)));
    expect(await screen.findByText(ENGLISH[0]!)).toBeInTheDocument();
  });

  it("is reachable from the keyboard: T sends the current line once", async () => {
    const client = healthClient(translationHealth(), {
      translateLine: vi.fn(async () => result(EP_A, 0, LINES[0]!, ENGLISH[0]!)),
    });
    renderLocalEpisode(client);
    await settle();
    await line(0);
    await userEvent.keyboard("t");
    expect(await screen.findByText(ENGLISH[0]!)).toBeInTheDocument();
    expect(client.translateLine).toHaveBeenCalledTimes(1);
    expect(screen.getByText(ENGLISH[0]!).closest("[aria-live]")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });

  it("shows fixed copy for a failure and retries only when asked", async () => {
    const translateLine = vi
      .fn<WorkerClient["translateLine"]>()
      .mockRejectedValueOnce(
        new WorkerError("TRANSLATION_UNAVAILABLE", "RAW worker text that must not show", {
          status: 503,
        }),
      )
      .mockResolvedValueOnce(await result(EP_A, 0, LINES[0]!, ENGLISH[0]!));
    const client = healthClient(translationHealth(), { translateLine });
    renderLocalEpisode(client);
    await settle();
    await userEvent.click((await englishButton(0))!);
    expect(
      await screen.findByText(TRANSLATION_MESSAGES.TRANSLATION_UNAVAILABLE!),
    ).toBeInTheDocument();
    expect(screen.queryByText(/RAW worker text/)).toBeNull();
    await settle();
    expect(translateLine).toHaveBeenCalledTimes(1); // no automatic retry
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(ENGLISH[0]!)).toBeInTheDocument();
    expect(translateLine).toHaveBeenCalledTimes(2);
  });

  it("an unreachable worker reads as unavailable", async () => {
    const client = healthClient(translationHealth(), {
      translateLine: vi.fn(async () => {
        throw new WorkerError("UNREACHABLE", "Pebble's local worker is not running.");
      }),
    });
    renderLocalEpisode(client);
    await settle();
    await userEvent.click((await englishButton(0))!);
    expect(
      await screen.findByText(TRANSLATION_MESSAGES.TRANSLATION_UNAVAILABLE!),
    ).toBeInTheDocument();
  });

  it("after the local limit, other taps send nothing and cached English still shows", async () => {
    const client = healthClient(translationHealth(), {
      getEpisodeTranslations: vi.fn(async () =>
        cachedRows(EP_A, [{ segment: 2, text: LINES[2]!, english: ENGLISH[2]! }]),
      ),
      translateLine: vi.fn(async () => {
        throw new WorkerError("TRANSLATION_LOCAL_LIMIT", "x", { status: 429 });
      }),
    });
    renderLocalEpisode(client);
    await settle();
    await userEvent.click((await englishButton(0))!);
    expect(
      await screen.findByText(TRANSLATION_MESSAGES.TRANSLATION_LOCAL_LIMIT!),
    ).toBeInTheDocument();
    await userEvent.click((await englishButton(1))!);
    await waitFor(() =>
      expect(screen.getAllByText(TRANSLATION_MESSAGES.TRANSLATION_LOCAL_LIMIT!)).toHaveLength(2),
    );
    await userEvent.click((await englishButton(2))!);
    expect(await screen.findByText(ENGLISH[2]!)).toBeInTheDocument();
    expect(client.translateLine).toHaveBeenCalledTimes(1);
  });

  it("a line that breaks the text rules is refused without a request", async () => {
    const client = healthClient(translationHealth());
    renderLocalEpisode(client);
    await settle();
    await userEvent.click((await line(0)).getByRole("button", { name: "Edit" }));
    const input = screen.getByRole("textbox", { name: "Edit this line" });
    await userEvent.clear(input);
    await userEvent.type(input, "OK only");
    await userEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await settle();
    await userEvent.click((await englishButton(0))!);
    expect(
      await screen.findByText(TRANSLATION_MESSAGES.TRANSLATION_INVALID_TEXT!),
    ).toBeInTheDocument();
    expect(client.translateLine).not.toHaveBeenCalled();
  });
});

// --- Consent -----------------------------------------------------------------------------

describe("local English — consent", () => {
  const needsConsent = () =>
    translationHealth({ consent: "required", newRequests: "consent_required" });

  it("opening the dialog grants nothing; Cancel sends nothing", async () => {
    const client = healthClient(needsConsent());
    renderLocalEpisode(client);
    await settle();
    const button = (await englishButton(0))!;
    await userEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: CONSENT_TITLE });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByText(CONSENT_BODY)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /details/i })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(client.grantTranslationConsent).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(client.grantTranslationConsent).not.toHaveBeenCalled();
    expect(client.translateLine).not.toHaveBeenCalled();
    expect(button).toHaveFocus();
  });

  it("Escape cancels, and Tab stays inside the dialog", async () => {
    const client = healthClient(needsConsent());
    renderLocalEpisode(client);
    await settle();
    await userEvent.click((await englishButton(0))!);
    const dialog = await screen.findByRole("dialog");
    await userEvent.tab();
    expect(within(dialog).getByRole("button", { name: "Translate" })).toHaveFocus();
    await userEvent.tab();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(client.grantTranslationConsent).not.toHaveBeenCalled();
    expect(client.translateLine).not.toHaveBeenCalled();
  });

  it("Translate records consent and sends that one line; later taps need no dialog", async () => {
    const client = healthClient(needsConsent(), {
      translateLine: vi
        .fn<WorkerClient["translateLine"]>()
        .mockResolvedValueOnce(await result(EP_A, 0, LINES[0]!, ENGLISH[0]!))
        .mockResolvedValueOnce(await result(EP_A, 1, LINES[1]!, ENGLISH[1]!)),
    });
    renderLocalEpisode(client);
    await settle();
    await userEvent.click((await englishButton(0))!);
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Translate" }),
    );
    expect(await screen.findByText(ENGLISH[0]!)).toBeInTheDocument();
    expect(client.grantTranslationConsent).toHaveBeenCalledTimes(1);
    expect(client.grantTranslationConsent).toHaveBeenCalledWith("deepl-2026-10");
    expect(client.translateLine).toHaveBeenCalledTimes(1);
    await userEvent.click((await englishButton(1))!);
    expect(await screen.findByText(ENGLISH[1]!)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(client.grantTranslationConsent).toHaveBeenCalledTimes(1);
  });

  it("an out-of-date consent version is explained once, with no loop and no request", async () => {
    const client = healthClient(needsConsent(), {
      grantTranslationConsent: vi.fn(async () => {
        throw new WorkerError("TRANSLATION_CONSENT_REQUIRED", "x", { status: 409 });
      }),
    });
    renderLocalEpisode(client);
    await settle();
    await userEvent.click((await englishButton(0))!);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Translate" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(CONSENT_OUT_OF_DATE);
    await settle();
    expect(client.grantTranslationConsent).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(client.translateLine).not.toHaveBeenCalled();
  });

  it("a request refused for consent says so, without reopening anything by itself", async () => {
    const client = healthClient(translationHealth(), {
      translateLine: vi.fn(async () => {
        throw new WorkerError("TRANSLATION_CONSENT_REQUIRED", "x", { status: 409 });
      }),
    });
    renderLocalEpisode(client);
    await settle();
    await userEvent.click((await englishButton(0))!);
    expect(
      await screen.findByText(TRANSLATION_MESSAGES.TRANSLATION_CONSENT_REQUIRED!),
    ).toBeInTheDocument();
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(client.translateLine).toHaveBeenCalledTimes(1);
    // Asking again is explicit: now the dialog opens (consent is required again).
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(client.translateLine).toHaveBeenCalledTimes(1);
  });
});

// --- Edits, reverts, late answers and navigation ------------------------------------------

describe("local English — edits and identity", () => {
  it("an edited line shows its old English as an earlier version; a revert makes it current", async () => {
    const client = healthClient(translationHealth(), {
      getEpisodeTranslations: vi.fn(async () =>
        cachedRows(EP_A, [{ segment: 0, text: LINES[0]!, english: ENGLISH[0]! }]),
      ),
      translateLine: vi.fn(async () => result(EP_A, 0, EDITED, "The weather is really nice,")),
    });
    renderLocalEpisode(client);
    await settle();
    await userEvent.click((await line(0)).getByRole("button", { name: "Edit" }));
    const input = screen.getByRole("textbox", { name: "Edit this line" });
    await userEvent.clear(input);
    await userEvent.type(input, EDITED);
    await userEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await settle();
    await userEvent.click((await englishButton(0))!);
    expect(await screen.findByText(STALE_LABEL, { exact: false })).toBeInTheDocument();
    expect(screen.getByText(ENGLISH[0]!)).toBeInTheDocument();
    expect(client.translateLine).not.toHaveBeenCalled(); // showing it sends nothing
    await userEvent.click(screen.getByRole("button", { name: "Translate again" }));
    expect(await screen.findByText("The weather is really nice,")).toBeInTheDocument();
    expect(client.translateLine).toHaveBeenCalledWith({
      episodeId: EP_A,
      segmentId: "seg-0001",
      text: EDITED,
    });
    expect(screen.queryByText(STALE_LABEL, { exact: false })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Revert" }));
    await settle();
    expect(await screen.findByText(ENGLISH[0]!)).toBeInTheDocument();
    expect(screen.queryByText(STALE_LABEL, { exact: false })).toBeNull();
    expect(client.translateLine).toHaveBeenCalledTimes(1);
  });

  it("a late answer for text that has since changed never shows as current", async () => {
    const pending = deferred<TranslationResult>();
    const client = healthClient(translationHealth(), {
      translateLine: vi.fn(() => pending.promise),
    });
    renderLocalEpisode(client);
    await settle();
    await userEvent.click((await englishButton(0))!);
    await userEvent.click((await line(0)).getByRole("button", { name: "Edit" }));
    const input = screen.getByRole("textbox", { name: "Edit this line" });
    await userEvent.clear(input);
    await userEvent.type(input, EDITED);
    await userEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await settle();
    await act(async () => pending.resolve(await result(EP_A, 0, LINES[0]!, ENGLISH[0]!)));
    await settle();
    // It describes the earlier text, so it's offered only as that.
    expect(await screen.findByText(STALE_LABEL, { exact: false })).toBeInTheDocument();
    expect(client.translateLine).toHaveBeenCalledTimes(1);
  });

  it("navigating to another episode drops a pending answer and sends nothing new", async () => {
    const pending = deferred<TranslationResult>();
    const client = healthClient(translationHealth(), {
      translateLine: vi.fn(() => pending.promise),
    });
    const view = renderLocalEpisode(client);
    await settle();
    await userEvent.click((await englishButton(0))!);
    view.navigate(EP_B);
    await screen.findByRole("heading", { name: "Episode B" });
    await settle();
    await act(async () => pending.resolve(await result(EP_A, 0, LINES[0]!, ENGLISH[0]!)));
    await settle();
    expect(screen.queryByText(ENGLISH[0]!)).toBeNull();
    expect(screen.queryByText("Loading translation…")).toBeNull();
    expect(client.translateLine).toHaveBeenCalledTimes(1);
    expect(client.getEpisodeTranslations).toHaveBeenCalledWith(EP_B);
  });

  it("unmounting during a request is quiet and sends nothing more", async () => {
    const pending = deferred<TranslationResult>();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = healthClient(translationHealth(), {
      translateLine: vi.fn(() => pending.promise),
    });
    const view = renderLocalEpisode(client);
    await settle();
    await userEvent.click((await englishButton(0))!);
    view.unmount();
    await act(async () => pending.resolve(await result(EP_A, 0, LINES[0]!, ENGLISH[0]!)));
    expect(client.translateLine).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });
});

// --- Privacy ---------------------------------------------------------------------------------

describe("local English — privacy", () => {
  it("logs nothing and stores nothing new in browser storage", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => {}),
    );
    const localBefore = { ...localStorage };
    const sessionBefore = { ...sessionStorage };
    const client = healthClient(
      translationHealth({ consent: "required", newRequests: "consent_required" }),
      {
        translateLine: vi
          .fn<WorkerClient["translateLine"]>()
          .mockResolvedValueOnce(await result(EP_A, 0, LINES[0]!, ENGLISH[0]!))
          .mockRejectedValueOnce(
            new WorkerError("TRANSLATION_UNAVAILABLE", "RAW", { status: 503 }),
          ),
      },
    );
    renderLocalEpisode(client);
    await settle();
    await userEvent.click((await englishButton(0))!);
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Translate" }),
    );
    await screen.findByText(ENGLISH[0]!);
    await userEvent.click((await englishButton(1))!);
    await screen.findByText(TRANSLATION_MESSAGES.TRANSLATION_UNAVAILABLE!);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect({ ...localStorage }).toEqual(localBefore);
    expect({ ...sessionStorage }).toEqual(sessionBefore);
  });

  it("the web copy matches docs/TRANSLATION.md exactly", () => {
    // Tests run from apps/web.
    const doc = readFileSync(`${process.cwd()}/../../docs/TRANSLATION.md`, "utf8");
    const section = doc.slice(doc.indexOf("## Errors"), doc.indexOf("## Testing"));
    const documented: Record<string, string> = {};
    for (const row of section.split("\n")) {
      const cells = row.split("|").map((cell) => cell.trim());
      if (cells.length === 6 && cells[2]?.startsWith("`")) {
        documented[cells[2].replaceAll("`", "")] = cells[4]!;
      }
    }
    expect(documented).toEqual(TRANSLATION_MESSAGES);
  });
});

// --- While the consent write is pending ----------------------------------------------------

describe("local English — consent pending", () => {
  const needsConsent = () =>
    translationHealth({ consent: "required", newRequests: "consent_required" });
  const granted = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    provider: "deepl" as const,
    status: "current" as const,
    consentVersion: "deepl-2026-10",
    grantedAt: "2026-10-07T12:00:00.000Z",
  };

  async function confirmWithPendingGrant(client: ReturnType<typeof healthClient>) {
    await userEvent.click((await englishButton(0))!);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Translate" }));
    expect(client.grantTranslationConsent).toHaveBeenCalledTimes(1);
  }

  it("an edit while consent is being recorded sends nothing", async () => {
    const grant = deferred<typeof granted>();
    const client = healthClient(needsConsent(), {
      grantTranslationConsent: vi.fn(() => grant.promise),
    });
    renderLocalEpisode(client);
    await settle();
    await confirmWithPendingGrant(client);
    // The line changes while the worker is still recording consent.
    await userEvent.click((await line(0)).getByRole("button", { name: "Edit" }));
    const input = screen.getByRole("textbox", { name: "Edit this line" });
    await userEvent.clear(input);
    await userEvent.type(input, EDITED);
    await userEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await settle();
    await act(async () => grant.resolve(granted));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(client.translateLine).not.toHaveBeenCalled();
  });

  it("navigating away while consent is being recorded sends nothing", async () => {
    const grant = deferred<typeof granted>();
    const client = healthClient(needsConsent(), {
      grantTranslationConsent: vi.fn(() => grant.promise),
    });
    const view = renderLocalEpisode(client);
    await settle();
    await confirmWithPendingGrant(client);
    view.navigate(EP_B);
    await screen.findByRole("heading", { name: "Episode B" });
    await act(async () => grant.resolve(granted));
    await settle();
    expect(client.translateLine).not.toHaveBeenCalled();
  });

  it("unmounting while consent is being recorded sends nothing and stays quiet", async () => {
    const grant = deferred<typeof granted>();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = healthClient(needsConsent(), {
      grantTranslationConsent: vi.fn(() => grant.promise),
    });
    const view = renderLocalEpisode(client);
    await settle();
    await confirmWithPendingGrant(client);
    view.unmount();
    await act(async () => grant.resolve(granted));
    await settle();
    expect(client.translateLine).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("a failed consent write says no request was sent, and sends none", async () => {
    const client = healthClient(needsConsent(), {
      grantTranslationConsent: vi.fn(async () => {
        throw new WorkerError("UNREACHABLE", "Pebble's local worker is not running.");
      }),
    });
    renderLocalEpisode(client);
    await settle();
    await userEvent.click((await englishButton(0))!);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Translate" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(CONSENT_FAILED);
    expect(CONSENT_FAILED).toBe(
      "Pebble couldn't record your choice. No translation request was sent.",
    );
    await settle();
    expect(client.grantTranslationConsent).toHaveBeenCalledTimes(1);
    expect(client.translateLine).not.toHaveBeenCalled();
  });
});

// --- Saving: fingerprint-safe snapshots ------------------------------------------------------

describe("local English — saving", () => {
  const save = async (n: number) =>
    userEvent.click((await line(n)).getByRole("button", { name: "Save" }));
  const savedEnglish = async (store: MemoryLearningStore) => {
    await settle();
    return (await store.listItems()).map((item) => item.translation);
  };
  const withCache = (overrides: Partial<WorkerClient> = {}) =>
    healthClient(translationHealth(), {
      getEpisodeTranslations: vi.fn(async () =>
        cachedRows(EP_A, [{ segment: 0, text: LINES[0]!, english: ENGLISH[0]! }]),
      ),
      ...overrides,
    });

  it("saves English that matches the displayed text, without a request", async () => {
    const client = withCache();
    const { store } = renderLocalEpisode(client);
    await settle();
    await save(0);
    expect(await savedEnglish(store)).toEqual([ENGLISH[0]]);
    expect(client.translateLine).not.toHaveBeenCalled();
  });

  it("never saves an earlier version's English for an edited line", async () => {
    const client = withCache();
    const { store } = renderLocalEpisode(client);
    await settle();
    await userEvent.click((await line(0)).getByRole("button", { name: "Edit" }));
    const input = screen.getByRole("textbox", { name: "Edit this line" });
    await userEvent.clear(input);
    await userEvent.type(input, EDITED);
    await userEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await settle();
    await save(0);
    const [item] = await store.listItems();
    expect(item?.text).toBe(EDITED);
    expect(item?.translation).toBeNull();
    expect(client.translateLine).not.toHaveBeenCalled();
  });

  it("after a revert, saves the English that matches again", async () => {
    const client = withCache();
    const { store } = renderLocalEpisode(client);
    await settle();
    await userEvent.click((await line(0)).getByRole("button", { name: "Edit" }));
    const input = screen.getByRole("textbox", { name: "Edit this line" });
    await userEvent.clear(input);
    await userEvent.type(input, EDITED);
    await userEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Revert" }));
    await settle();
    await save(0);
    expect(await savedEnglish(store)).toEqual([ENGLISH[0]]);
  });

  it("saves no English while a request is pending, and a late answer doesn't rewrite it", async () => {
    const pending = deferred<TranslationResult>();
    const client = healthClient(translationHealth(), {
      translateLine: vi.fn(() => pending.promise),
    });
    const { store } = renderLocalEpisode(client);
    await settle();
    await userEvent.click((await englishButton(1))!);
    await save(1);
    expect(await savedEnglish(store)).toEqual([null]);
    await act(async () => pending.resolve(await result(EP_A, 1, LINES[1]!, ENGLISH[1]!)));
    expect(await screen.findByText(ENGLISH[1]!)).toBeInTheDocument();
    expect(await savedEnglish(store)).toEqual([null]); // the saved snapshot stays as it was
    expect(client.translateLine).toHaveBeenCalledTimes(1);
  });

  it("saves no English after a failed request", async () => {
    const client = healthClient(translationHealth(), {
      translateLine: vi.fn(async () => {
        throw new WorkerError("TRANSLATION_UNAVAILABLE", "x", { status: 503 });
      }),
    });
    const { store } = renderLocalEpisode(client);
    await settle();
    await userEvent.click((await englishButton(1))!);
    await screen.findByText(TRANSLATION_MESSAGES.TRANSLATION_UNAVAILABLE!);
    await save(1);
    expect(await savedEnglish(store)).toEqual([null]);
  });

  it("a saved snapshot isn't rewritten by later edits or translations", async () => {
    const client = withCache({
      translateLine: vi.fn(async () => result(EP_A, 0, EDITED, "Newer English.")),
    });
    const { store } = renderLocalEpisode(client);
    await settle();
    await save(0);
    await userEvent.click((await line(0)).getByRole("button", { name: "Edit" }));
    const input = screen.getByRole("textbox", { name: "Edit this line" });
    await userEvent.clear(input);
    await userEvent.type(input, EDITED);
    await userEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await settle();
    await userEvent.click((await englishButton(0))!);
    await userEvent.click(screen.getByRole("button", { name: "Translate again" }));
    await screen.findByText("Newer English.");
    const [item] = await store.listItems();
    expect(item?.text).toBe(LINES[0]);
    expect(item?.translation).toBe(ENGLISH[0]);
  });
});

// --- Export: saved snapshots only ------------------------------------------------------------

describe("local English — export", () => {
  async function itemFor(segment: number, translation: string | null, text = LINES[segment]!) {
    const transcript = asrTranscript(EP_A);
    const seg = transcript.segments[segment]!;
    return buildLearningItem({
      episode: {
        ...testEpisode,
        id: EP_A,
        title: "Episode A",
        demo: undefined,
        audioProvenance: { kind: "user-provided", publishable: false, notes: "Yours." },
      },
      transcript,
      segment: seg,
      correction:
        text === seg.text
          ? null
          : {
              schemaVersion: CURRENT_SCHEMA_VERSION,
              episodeId: EP_A,
              segmentId: seg.id,
              originalText: seg.text,
              correctedText: text,
              updatedAt: "2026-10-07T00:00:00.000Z",
            },
      pinyin: "pinyin",
      translation,
    });
  }

  it("exports only the saved snapshots and never asks the worker for English", async () => {
    const store = new MemoryLearningStore();
    await store.putItem(await itemFor(0, "Saved snapshot English."));
    await store.putItem(await itemFor(1, null));
    await store.putItem(await itemFor(2, null, "好的好的。"));
    const client = healthClient(translationHealth(), {
      // A different, newer cache must not leak into the export.
      getEpisodeTranslations: vi.fn(async () =>
        cachedRows(EP_A, [{ segment: 1, text: LINES[1]!, english: "Newer cached English." }]),
      ),
    });
    render(
      <WorkerProvider client={client}>
        <LocalTranslationProvider>
          <SourceProvider source={source()}>
            <TranslationProviderContext
              provider={new SessionCachedTranslationProvider(fakeTranslationProvider().provider)}
            >
              <LearningProvider openStore={() => Promise.resolve(store)}>
                <MemoryRouter>
                  <LearningItemsPage />
                </MemoryRouter>
              </LearningProvider>
            </TranslationProviderContext>
          </SourceProvider>
        </LocalTranslationProvider>
      </WorkerProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Export CSV for Anki" }));
    await waitFor(() => expect(downloadText).toHaveBeenCalled());
    const csv = downloadText.mock.lastCall![1] as string;
    expect(csv).toContain("Saved snapshot English.");
    expect(csv).not.toContain("Newer cached English.");
    expect(csv).toContain("好的好的。"); // the saved (edited) text, not the transcript's
    const rows = csv.trim().split("\n").slice(4);
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.split(",")[2] === "")).toHaveLength(2); // no new English
    expect(client.translateLine).not.toHaveBeenCalled();
    expect(client.getEpisodeTranslations).not.toHaveBeenCalled();
  });
});

// --- Settings, withdrawal and refresh -----------------------------------------------------

function renderSettings(client: WorkerClient) {
  return render(
    <WorkerProvider client={client}>
      <LocalTranslationProvider>
        <SettingsRouter>
          <TranslationSettingsPage />
        </SettingsRouter>
      </LocalTranslationProvider>
    </WorkerProvider>,
  );
}

describe("local English — settings", () => {
  it("shows the approved details and links", async () => {
    renderSettings(healthClient(translationHealth()));
    expect(await screen.findByText(SETTINGS.allowed, { exact: false })).toBeInTheDocument();
    for (const detail of SETTINGS.details) expect(screen.getByText(detail)).toBeInTheDocument();
    for (const link of SETTINGS.links) {
      const anchor = screen.getByRole("link", { name: link.text });
      expect(anchor).toHaveAttribute("href", link.href);
      expect(anchor).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("withdraws only on an explicit click, after the worker confirms", async () => {
    const withdrawn = deferred<Awaited<ReturnType<WorkerClient["withdrawTranslationConsent"]>>>();
    const client = healthClient(translationHealth(), {
      withdrawTranslationConsent: vi.fn(() => withdrawn.promise),
    });
    renderSettings(client);
    const button = await screen.findByRole("button", { name: SETTINGS.withdraw });
    await settle();
    expect(client.withdrawTranslationConsent).not.toHaveBeenCalled();
    await userEvent.click(button);
    expect(client.withdrawTranslationConsent).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(SETTINGS.afterWithdrawal)).toBeNull(); // not until confirmed
    await act(async () =>
      withdrawn.resolve({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        provider: "deepl",
        status: "required",
        consentVersion: "deepl-2026-10",
        grantedAt: null,
      }),
    );
    expect(await screen.findByText(SETTINGS.afterWithdrawal)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: SETTINGS.withdraw })).toBeNull();
    expect(client.translateLine).not.toHaveBeenCalled();
    expect(client.grantTranslationConsent).not.toHaveBeenCalled();
  });

  it("a failed withdrawal keeps the last confirmed state and says so", async () => {
    const client = healthClient(translationHealth(), {
      withdrawTranslationConsent: vi.fn(async () => {
        throw new WorkerError("UNREACHABLE", "Pebble's local worker is not running.");
      }),
    });
    renderSettings(client);
    await userEvent.click(await screen.findByRole("button", { name: SETTINGS.withdraw }));
    expect(await screen.findByText(SETTINGS.withdrawFailed)).toBeInTheDocument();
    expect(screen.getByText(SETTINGS.allowed, { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(SETTINGS.afterWithdrawal)).toBeNull();
    expect(client.withdrawTranslationConsent).toHaveBeenCalledTimes(1); // no automatic retry
  });

  it("a withdrawal the worker doesn't confirm counts as failed", async () => {
    const client = healthClient(translationHealth(), {
      withdrawTranslationConsent: vi.fn(async () => ({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        provider: "deepl" as const,
        status: "current" as const,
        consentVersion: "deepl-2026-10",
        grantedAt: "2026-10-07T12:00:00.000Z",
      })),
    });
    renderSettings(client);
    await userEvent.click(await screen.findByRole("button", { name: SETTINGS.withdraw }));
    expect(await screen.findByText(SETTINGS.withdrawFailed)).toBeInTheDocument();
  });

  it("after withdrawal, a tap on a line asks for consent again; cached English still shows", async () => {
    const client = healthClient(translationHealth(), {
      getEpisodeTranslations: vi.fn(async () =>
        cachedRows(EP_A, [{ segment: 0, text: LINES[0]!, english: ENGLISH[0]! }]),
      ),
    });
    render(
      <WorkerProvider client={client}>
        <LocalTranslationProvider>
          <SourceProvider source={source()}>
            <TranslationProviderContext
              provider={new SessionCachedTranslationProvider(fakeTranslationProvider().provider)}
            >
              <LearningProvider openStore={() => Promise.resolve(new MemoryLearningStore())}>
                <MemoryRouter>
                  <TranslationSettingsPage />
                  <EpisodePage episodeId={EP_A} />
                </MemoryRouter>
              </LearningProvider>
            </TranslationProviderContext>
          </SourceProvider>
        </LocalTranslationProvider>
      </WorkerProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: SETTINGS.withdraw }));
    await screen.findByText(SETTINGS.afterWithdrawal);
    await settle();
    await userEvent.click((await englishButton(0))!);
    expect(await screen.findByText(ENGLISH[0]!)).toBeInTheDocument(); // still readable
    await userEvent.click((await englishButton(1))!);
    expect(await screen.findByRole("dialog", { name: CONSENT_TITLE })).toBeInTheDocument();
    expect(client.translateLine).not.toHaveBeenCalled();
  });

  it("shows the not-set-up message, and no Withdraw, when translation is off", async () => {
    renderSettings(
      healthClient(
        translationHealth({ configured: false, consent: "not_configured", newRequests: "off" }),
      ),
    );
    expect(await screen.findAllByText(TRANSLATION_MESSAGES.TRANSLATION_OFF!)).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: SETTINGS.withdraw })).toBeNull();
  });
});

describe("local English — limit recovery", () => {
  const limited = () =>
    translationHealth({
      newRequests: "local_limit_reached",
      limits: {
        period: "2026-10",
        requestsUsed: 300,
        requestLimit: 300,
        charactersUsed: 10,
        characterLimit: 30000,
      },
    });
  const reachable = (translation: TranslationHealth | undefined) =>
    parseWorkerHealth({ ...funasrHealth(), ...(translation ? { translation } : {}) });

  async function limitedThen(next: () => Promise<ReturnType<typeof parseWorkerHealth>>) {
    const health = vi
      .fn<WorkerClient["health"]>()
      .mockResolvedValueOnce(reachable(limited()))
      .mockImplementationOnce(next);
    const client = fakeWorkerClient({ health });
    renderSettings(client);
    expect(
      await screen.findByText(TRANSLATION_MESSAGES.TRANSLATION_LOCAL_LIMIT!, { exact: false }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: SETTINGS.checkAgain }));
    await settle();
    expect(health).toHaveBeenCalledTimes(2);
    expect(client.translateLine).not.toHaveBeenCalled();
    return client;
  }

  it("limit reached, then available: the limit message goes; nothing is translated", async () => {
    await limitedThen(async () => reachable(translationHealth()));
    await waitFor(() =>
      expect(
        screen.queryByText(TRANSLATION_MESSAGES.TRANSLATION_LOCAL_LIMIT!, { exact: false }),
      ).toBeNull(),
    );
    expect(screen.getByText(SETTINGS.allowed, { exact: false })).toBeInTheDocument();
  });

  it("still limited: stays limited", async () => {
    await limitedThen(async () => reachable(limited()));
    expect(
      screen.getByText(TRANSLATION_MESSAGES.TRANSLATION_LOCAL_LIMIT!, { exact: false }),
    ).toBeInTheDocument();
  });

  it("consent required after the refresh", async () => {
    await limitedThen(async () =>
      reachable(translationHealth({ consent: "required", newRequests: "consent_required" })),
    );
    expect(await screen.findByText(SETTINGS.notAllowed)).toBeInTheDocument();
  });

  it("off after the refresh", async () => {
    await limitedThen(async () =>
      reachable(
        translationHealth({ configured: false, consent: "not_configured", newRequests: "off" }),
      ),
    );
    expect(await screen.findByText(TRANSLATION_MESSAGES.TRANSLATION_OFF!)).toBeInTheDocument();
  });

  it("an unreachable worker changes nothing and says so", async () => {
    await limitedThen(async () => {
      throw new WorkerError("UNREACHABLE", "Pebble's local worker is not running.");
    });
    expect(await screen.findByText(SETTINGS.checkFailed)).toBeInTheDocument();
    expect(
      screen.getByText(TRANSLATION_MESSAGES.TRANSLATION_LOCAL_LIMIT!, { exact: false }),
    ).toBeInTheDocument();
  });
});

describe("local English — settings link", () => {
  function renderShell(client: WorkerClient | null) {
    const shell = (
      <LearningProvider openStore={() => Promise.resolve(new MemoryLearningStore())}>
        <SettingsRouter>
          <Routes>
            <Route path="/" element={<Layout mode="local" />} />
          </Routes>
        </SettingsRouter>
      </LearningProvider>
    );
    return render(
      client ? (
        <WorkerProvider client={client}>
          <LocalTranslationProvider>{shell}</LocalTranslationProvider>
        </WorkerProvider>
      ) : (
        shell
      ),
    );
  }

  it("isn't in the sidebar, even when the local app provides translation", async () => {
    renderShell(healthClient(translationHealth()));
    await screen.findByRole("navigation", { name: "Main" });
    await act(async () => {}); // let health resolve
    expect(screen.queryByRole("link", { name: /translation/i })).toBeNull();
  });

  it("opens from the episode's ⋯ menu", async () => {
    const client = healthClient(translationHealth());
    render(
      <WorkerProvider client={client}>
        <LocalTranslationProvider>
          <SourceProvider source={source()}>
            <TranslationProviderContext
              provider={new SessionCachedTranslationProvider(fakeTranslationProvider().provider)}
            >
              <LearningProvider openStore={() => Promise.resolve(new MemoryLearningStore())}>
                <SettingsRouter>
                  <Routes>
                    <Route path="/" element={<EpisodePage episodeId={EP_A} />} />
                    <Route path="/translation" element={<p>Settings page</p>} />
                  </Routes>
                </SettingsRouter>
              </LearningProvider>
            </TranslationProviderContext>
          </SourceProvider>
        </LocalTranslationProvider>
      </WorkerProvider>,
    );
    await settle();
    await userEvent.click(await screen.findByRole("button", { name: "Transcript actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: LABELS.settings }));
    expect(await screen.findByText("Settings page")).toBeInTheDocument();
  });
});

describe("local English — withdrawal uncertainty", () => {
  it("uses the approved copy", () => {
    expect(SETTINGS.withdrawFailed).toBe(
      "Pebble couldn't confirm that your choice was withdrawn. Try again.",
    );
    expect(SETTINGS.checkFailed).toBe(
      "Pebble couldn't check right now. The displayed status hasn't changed.",
    );
    expect(SETTINGS.notAllowed).toBe(
      "English translation with DeepL isn't allowed on this computer yet. Pebble asks the first time you tap English on a line.",
    );
    expect([SETTINGS.title, LABELS.settings, SETTINGS.checkAgain]).toEqual([
      "English translation",
      "Translation settings",
      "Check again",
    ]);
  });

  it("a lost withdrawal response that did take effect is handled safely later", async () => {
    const client = healthClient(translationHealth(), {
      // The worker withdrew, but the response never arrived.
      withdrawTranslationConsent: vi.fn(async () => {
        throw new WorkerError("UNREACHABLE", "Pebble's local worker is not running.");
      }),
      translateLine: vi.fn(async () => {
        throw new WorkerError("TRANSLATION_CONSENT_REQUIRED", "x", { status: 409 });
      }),
    });
    render(
      <WorkerProvider client={client}>
        <LocalTranslationProvider>
          <SourceProvider source={source()}>
            <TranslationProviderContext
              provider={new SessionCachedTranslationProvider(fakeTranslationProvider().provider)}
            >
              <LearningProvider openStore={() => Promise.resolve(new MemoryLearningStore())}>
                <MemoryRouter>
                  <TranslationSettingsPage />
                  <EpisodePage episodeId={EP_A} />
                </MemoryRouter>
              </LearningProvider>
            </TranslationProviderContext>
          </SourceProvider>
        </LocalTranslationProvider>
      </WorkerProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: SETTINGS.withdraw }));
    expect(await screen.findByText(SETTINGS.withdrawFailed)).toBeInTheDocument();
    // Last confirmed status stays, Withdraw can be pressed again; nothing else happens.
    expect(screen.getByRole("button", { name: SETTINGS.withdraw })).toBeInTheDocument();
    expect(client.translateLine).not.toHaveBeenCalled();
    await settle();
    // The next explicit tap meets the worker's refusal: one request, fixed copy, no dialog.
    await userEvent.click((await englishButton(0))!);
    expect(
      await screen.findByText(TRANSLATION_MESSAGES.TRANSLATION_CONSENT_REQUIRED!),
    ).toBeInTheDocument();
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(client.translateLine).toHaveBeenCalledTimes(1);
    // Readiness now reflects it: settings no longer offer Withdraw.
    expect(await screen.findByText(SETTINGS.notAllowed)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: SETTINGS.withdraw })).toBeNull();
    expect(screen.queryByText(SETTINGS.withdrawFailed)).toBeNull();
  });
});
