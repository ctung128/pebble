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
import type { EpisodeSource, ResolvedEpisode } from "../data/EpisodeSource.ts";
import { SourceProvider } from "../data/SourceContext.tsx";
import { EpisodePage } from "../features/episode/EpisodePage.tsx";
import { LearningProvider } from "../features/learning/LearningContext.tsx";
import { MemoryLearningStore } from "../features/learning/MemoryLearningStore.ts";
import { TranslationProviderContext } from "../features/translation/TranslationContext.tsx";
import { SessionCachedTranslationProvider } from "../features/translation/TranslationProvider.ts";
import { fingerprintOf } from "../features/translation/workerTranslation.ts";
import { fakeTranslationProvider, renderWithProviders, testEpisode } from "../test/fixtures.tsx";
import { fakeWorkerClient, funasrHealth } from "../test/localFixtures.tsx";
import { LocalTranslationProvider } from "./LocalTranslationProvider.tsx";
import {
  ATTRIBUTION,
  CONSENT_BODY,
  CONSENT_FAILED,
  CONSENT_OUT_OF_DATE,
  CONSENT_TITLE,
  LABELS,
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
    expect(screen.queryByRole("button", { name: "Show saved English" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps mock transcripts out of it entirely", async () => {
    const client = healthClient(translationHealth());
    renderLocalEpisode(client, { kind: "mock" });
    await settle();
    await line(0);
    expect(client.getEpisodeTranslations).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Show saved English" })).toBeNull();
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
    const toggle = await screen.findByRole("button", { name: "Show saved English" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    expect(await screen.findByText(ENGLISH[0]!)).toBeInTheDocument();
    expect(screen.queryByText("An old version.")).toBeNull(); // not current for its line
    expect(screen.getByRole("button", { name: "Hide saved English" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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
