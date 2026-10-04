import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceError } from "../../data/EpisodeSource.ts";
import {
  fakeSource,
  fakeTranslationProvider,
  renderWithProviders,
  testEpisode,
  testTranscript,
} from "../../test/fixtures.tsx";
import { buildLearningItem } from "../learning/buildLearningItem.ts";
import { MemoryLearningStore } from "../learning/MemoryLearningStore.ts";
import { COPY_LABEL } from "../reader/copyText.ts";
import { EpisodePage } from "./EpisodePage.tsx";

type RenderOptions = Parameters<typeof renderWithProviders>[1];

function savedItem(overrides: { note?: string } = {}) {
  return {
    ...buildLearningItem({
      episode: testEpisode,
      transcript: testTranscript,
      segment: testTranscript.segments[0]!,
      correction: null,
      pinyin: null,
      translation: null,
    }),
    note: overrides.note ?? null,
  };
}

function renderPage(options: RenderOptions & { episodeId?: string } = {}) {
  return renderWithProviders(<EpisodePage episodeId={options.episodeId ?? "test-001"} />, options);
}

async function playButtons() {
  const list = await screen.findByRole("list", { name: "Transcript" });
  return within(list).getAllByRole("button", { name: /^\d+:\d\d/ });
}

/** The action group for the n-th line (0-based). */
async function lineActions(n: number) {
  await playButtons();
  return within(screen.getByRole("group", { name: `Line at 0:0${n * 3}` }));
}

const activeText = () =>
  screen.getAllByRole("button").find((b) => b.getAttribute("aria-current") === "true")
    ?.textContent ?? null;

describe("EpisodePage — listening", () => {
  it("shows the episode, transcript and sample disclosures", async () => {
    renderPage();
    expect(await playButtons()).toHaveLength(3);
    expect(screen.getByRole("heading", { name: "Test episode" })).toBeInTheDocument();
    expect(screen.getByText(/Development placeholder/)).toBeInTheDocument();
    expect(screen.getByText(/not speech-recognition output/)).toBeInTheDocument();
    expect(
      screen.getByText("Translations in this demo are prepared sample content."),
    ).toBeInTheDocument();
  });

  it("starts on the first line and steps with the arrow keys", async () => {
    renderPage();
    await playButtons();
    expect(activeText()).toContain("第一句。");
    await userEvent.keyboard("{ArrowRight}");
    expect(activeText()).toContain("第二句。");
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(activeText()).toContain("第三句。");
    await userEvent.keyboard("{ArrowLeft}");
    expect(activeText()).toContain("第二句。");
  });

  it("seeks and plays when a line is clicked", async () => {
    renderPage();
    const rows = await playButtons();
    await userEvent.click(rows[2]!);
    expect(activeText()).toContain("第三句。");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it("toggles playback with Space and replays with R", async () => {
    renderPage();
    await playButtons();
    await userEvent.keyboard(" ");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("r");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  });

  it("does not activate a focused line when Space is pressed", async () => {
    renderPage();
    const rows = await playButtons();
    act(() => rows[2]!.focus());
    await userEvent.keyboard(" ");
    expect(activeText()).toContain("第一句。");
  });

  it("cues the line named in ?segment=", async () => {
    renderPage({ route: "/?segment=seg-3" });
    await playButtons();
    await waitFor(() => expect(activeText()).toContain("第三句。"));
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it("shows a structured error with retry when loading fails", async () => {
    let attempts = 0;
    const source = fakeSource({
      getTranscript: async () => {
        attempts += 1;
        throw new SourceError("INVALID_PAYLOAD", "Transcript is invalid: segments.0.endMs — bad");
      },
    });
    renderPage({ source });
    expect(await screen.findByRole("alert")).toHaveTextContent("Content is malformed");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("alert");
    expect(attempts).toBe(2);
  });

  it("still loads when review hints fail", async () => {
    renderPage({
      source: fakeSource({
        getReviewHints: async () => {
          throw new Error("offline");
        },
      }),
    });
    expect(await playButtons()).toHaveLength(3);
  });
});

describe("EpisodePage — pinyin", () => {
  it("is hidden by default and revealed per line", async () => {
    renderPage();
    const line = await lineActions(0);
    expect(screen.queryByText(/dì yī jù/)).not.toBeInTheDocument();
    await userEvent.click(line.getByRole("button", { name: "Pinyin" }));
    expect(await screen.findByText("dì yī jù。")).toBeInTheDocument();
    expect(screen.queryByText(/dì èr jù/)).not.toBeInTheDocument();
  });

  it("can be shown and hidden for all lines", async () => {
    renderPage();
    await playButtons();
    await userEvent.click(screen.getByRole("button", { name: "Show pinyin" }));
    expect(await screen.findByText("dì sān jù。")).toBeInTheDocument();
    expect(screen.getByText("dì yī jù。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Hide pinyin" }));
    expect(screen.queryByText("dì sān jù。")).not.toBeInTheDocument();
  });

  it("explains that pinyin is generated", async () => {
    renderPage();
    await playButtons();
    await userEvent.click(screen.getByRole("button", { name: "About pinyin" }));
    expect(screen.getByText(/generated automatically and may be imperfect/)).toBeInTheDocument();
  });
});

describe("EpisodePage — translation", () => {
  it("requests nothing until a line's English is opened", async () => {
    const { provider, translate } = fakeTranslationProvider();
    renderPage({ translation: provider });
    const line = await lineActions(1);
    expect(translate).not.toHaveBeenCalled();

    await userEvent.click(line.getByRole("button", { name: "English" }));
    expect(await screen.findByText("The second sentence.")).toBeInTheDocument();
    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledWith(expect.objectContaining({ segmentId: "seg-2" }));
  });

  it("reuses the session cache when reopened", async () => {
    const { provider, translate } = fakeTranslationProvider();
    renderPage({ translation: provider });
    const button = (await lineActions(0)).getByRole("button", { name: "English" });
    await userEvent.click(button);
    await screen.findByText("The first sentence.");
    await userEvent.click(button);
    expect(screen.queryByText("The first sentence.")).not.toBeInTheDocument();
    await userEvent.click(button);
    expect(screen.getByText("The first sentence.")).toBeInTheDocument();
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it("shows a retryable error", async () => {
    const failing = fakeTranslationProvider({ fail: true });
    renderPage({ translation: failing.provider });
    await userEvent.click((await lineActions(0)).getByRole("button", { name: "English" }));
    expect(
      await screen.findByText(
        /Translation is unavailable right now. Try again, or keep listening./,
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(failing.translate).toHaveBeenCalledTimes(2));
  });

  it("opens with T for the current line", async () => {
    const { provider } = fakeTranslationProvider();
    renderPage({ translation: provider });
    await playButtons();
    await userEvent.keyboard("t");
    expect(await screen.findByText("The first sentence.")).toBeInTheDocument();
  });
});

describe("EpisodePage — corrections", () => {
  async function editLine(n: number, text: string) {
    await userEvent.click((await lineActions(n)).getByRole("button", { name: "Edit" }));
    const input = screen.getByRole("textbox", { name: "Edit this line" });
    await userEvent.clear(input);
    await userEvent.type(input, text);
    await userEvent.click(screen.getByRole("button", { name: "Save edit" }));
  }

  it("edits, shows the original, persists, and reverts", async () => {
    const store = new MemoryLearningStore();
    const first = renderPage({ store });
    await editLine(1, "第二句话。");

    const rows = await playButtons();
    expect(rows[1]).toHaveTextContent("第二句话。");
    expect(screen.getByText("Edited by you")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show original" }));
    expect(screen.getByText(/Original transcript:/)).toHaveTextContent("第二句。");

    const [stored] = await store.listCorrections();
    expect(stored).toMatchObject({
      episodeId: "test-001",
      segmentId: "seg-2",
      originalText: "第二句。",
      correctedText: "第二句话。",
    });
    expect(Date.parse(stored!.updatedAt)).not.toBeNaN();

    // A fresh app session over the same store still shows the edit.
    first.unmount();
    renderPage({ store });
    expect((await playButtons())[1]).toHaveTextContent("第二句话。");

    await userEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect((await playButtons())[1]).toHaveTextContent("第二句。");
    expect(screen.queryByText("Edited by you")).not.toBeInTheDocument();
    await waitFor(async () => expect(await store.listCorrections()).toEqual([]));
  });

  it("keeps the editor open with an error for empty text", async () => {
    renderPage();
    await userEvent.click((await lineActions(0)).getByRole("button", { name: "Edit" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "Edit this line" }));
    await userEvent.click(screen.getByRole("button", { name: "Save edit" }));
    expect(screen.getByRole("alert")).toHaveTextContent("A line can't be empty.");
  });

  it("cancels with Escape without changing the line", async () => {
    renderPage();
    await userEvent.click((await lineActions(0)).getByRole("button", { name: "Edit" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Edit this line" }), "xyz{Escape}");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect((await playButtons())[0]).toHaveTextContent("第一句。");
  });

  it("does not offer the prepared translation for edited text", async () => {
    renderPage();
    await editLine(0, "第一句话。");
    await userEvent.click((await lineActions(0)).getByRole("button", { name: "English" }));
    expect(await screen.findByText("No translation for edited text.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });
});

describe("EpisodePage — learning items", () => {
  it("saves a line with its displayed text, pinyin, translation and provenance", async () => {
    const store = new MemoryLearningStore();
    renderPage({ store });
    const line = await lineActions(1);
    await userEvent.click(line.getByRole("button", { name: "Pinyin" }));
    await screen.findByText("dì èr jù。");
    await userEvent.click(line.getByRole("button", { name: "English" }));
    await screen.findByText("The second sentence.");
    await userEvent.click(line.getByRole("button", { name: "Save" }));

    expect(line.getByRole("button", { name: "Saved" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(async () => expect(await store.listItems()).toHaveLength(1));
    const [item] = await store.listItems();
    expect(item).toMatchObject({
      kind: "segment",
      episodeId: "test-001",
      episodeTitle: "Test episode",
      segmentId: "seg-2",
      startMs: 3000,
      endMs: 5500,
      text: "第二句。",
      originalText: null,
      pinyin: "dì èr jù。",
      translation: "The second sentence.",
      note: null,
      provenance: {
        transcriptKind: "fixture",
        transcriptProvider: "fixture",
        corrected: false,
        audioKind: "tts-placeholder",
      },
    });
  });

  it("leaves pinyin and translation empty when they weren't generated", async () => {
    const store = new MemoryLearningStore();
    renderPage({ store });
    await playButtons();
    await userEvent.keyboard("s");
    await waitFor(async () => expect(await store.listItems()).toHaveLength(1));
    expect((await store.listItems())[0]).toMatchObject({ pinyin: null, translation: null });
  });

  it("unsaves directly when there is no note", async () => {
    const store = new MemoryLearningStore();
    renderPage({ store });
    const line = await lineActions(0);
    await userEvent.click(line.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect(await store.listItems()).toHaveLength(1));
    await userEvent.click(line.getByRole("button", { name: "Saved" }));
    await waitFor(async () => expect(await store.listItems()).toEqual([]));
  });

  it("asks before unsaving an item that has a note", async () => {
    const store = new MemoryLearningStore();
    await store.putItem(savedItem({ note: "keep me" }));
    renderPage({ store });
    const line = await lineActions(0);
    await userEvent.click(line.getByRole("button", { name: "Saved" }));
    expect(screen.getByText("Remove this learning item and its note?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await store.listItems()).toHaveLength(1);

    await userEvent.click(line.getByRole("button", { name: "Saved" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(async () => expect(await store.listItems()).toEqual([]));
  });
});

describe("EpisodePage — storage unavailable", () => {
  it("keeps edits and saves working for the session", async () => {
    renderPage({ openStore: () => Promise.reject(new Error("blocked")) });
    await userEvent.click((await lineActions(0)).getByRole("button", { name: "Save" }));
    expect((await lineActions(0)).getByRole("button", { name: "Saved" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("EpisodePage — mock (preview) transcripts", () => {
  const mockTranscript = {
    ...testTranscript,
    provenance: { ...testTranscript.provenance, kind: "mock" as const, provider: "mock" },
  };
  const mockSource = () =>
    fakeSource({
      getTranscript: async () => mockTranscript,
      getEpisode: async (id) => ({
        ...testEpisode,
        id,
        demo: undefined,
        audioProvenance: { kind: "user-provided", publishable: false, notes: "Yours." },
        audioUrl: "http://127.0.0.1:8790/episodes/x/audio",
      }),
    });

  it("shows the persistent preview banner and the translation capability note", async () => {
    renderPage({ source: mockSource() });
    await playButtons();
    const banner = screen.getByRole("note", { name: "Preview transcript" });
    expect(banner).toHaveTextContent(
      "Preview transcript: This is placeholder text used to test local audio processing. It is not a transcription of your audio.",
    );
    expect(banner).toHaveTextContent(
      "Translation will be available after a real transcription and translation provider are connected.",
    );
  });

  it("keeps learning tools visible but disabled, with an accessible explanation", async () => {
    const { provider, translate } = fakeTranslationProvider();
    const store = new MemoryLearningStore();
    renderPage({ source: mockSource(), translation: provider, store });
    const line = await lineActions(0);
    const explanation = screen.getByText(
      "Learning tools become available after Pebble creates a real transcript.",
    );
    for (const name of ["Pinyin", "English", "Save", "Edit"]) {
      const button = line.getByRole("button", { name });
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toHaveAttribute("aria-describedby", explanation.id);
      await userEvent.click(button);
    }
    const toolbar = screen.getByRole("button", { name: "Show pinyin" });
    expect(toolbar).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(toolbar);
    await userEvent.keyboard("pts");

    expect(screen.queryByText(/dì yī jù/)).not.toBeInTheDocument(); // no pinyin generated
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument(); // no correction editor
    expect(translate).not.toHaveBeenCalled();
    expect(await store.listItems()).toEqual([]);
  });

  it("still plays and navigates lines", async () => {
    renderPage({ source: mockSource() });
    const rows = await playButtons();
    await userEvent.click(rows[1]!);
    expect(activeText()).toContain("第二句。");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it("loads worker audio with CORS so the worker's origin check can pass", async () => {
    renderPage({ source: mockSource() });
    await playButtons();
    expect(document.querySelector("audio")).toHaveAttribute("crossorigin", "anonymous");
  });
});

describe("EpisodePage — local speech-recognition (ASR) transcripts", () => {
  // ASR transcripts only exist in the local-mode build.
  beforeEach(() => vi.stubGlobal("__PEBBLE_LOCAL__", true));
  afterEach(() => vi.stubGlobal("__PEBBLE_LOCAL__", false));

  // Invented text; ASR provenance as the local worker writes it.
  const asrTranscript = {
    ...testTranscript,
    segments: testTranscript.segments.map((segment) => ({
      ...segment,
      speaker: null,
      chunkIndex: 0,
      review: { flags: segment.index === 0 ? ["long_segment" as const] : [] },
    })),
    provenance: {
      kind: "asr" as const,
      provider: "funasr",
      model: "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
      createdAt: "2026-10-03T00:00:00Z",
      notes: "Transcribed on this computer with FunASR Paraformer",
    },
  };
  const asrSource = () =>
    fakeSource({
      getTranscript: async () => asrTranscript,
      getEpisode: async (id) => ({
        ...testEpisode,
        id,
        demo: undefined,
        audioProvenance: { kind: "user-provided", publishable: false, notes: "Yours." },
        audioUrl: "http://127.0.0.1:8790/episodes/x/audio",
      }),
    });

  it("shows the local transcript notice instead of mock or demo notices", async () => {
    renderPage({ source: asrSource() });
    await playButtons();
    const notice = screen.getByRole("complementary", { name: "Local transcript" });
    expect(within(notice).getByRole("heading", { name: "Local transcript" })).toBeInTheDocument();
    expect(notice).toHaveTextContent(
      "Pebble creates a machine transcript on your computer. It can mishear or miss parts of fast or conversational speech. Replay the audio and edit any line that looks wrong.",
    );
    // The model is secondary: inside a collapsed "Transcript details", not the notice text.
    const details = within(notice).getByText("Transcript details").closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent("Transcribed on this computer with FunASR Paraformer");
    expect(notice).not.toHaveTextContent(/iic\/|\.pebble|\.m4a|\.wav/);
    expect(screen.queryByRole("note", { name: "Preview transcript" })).not.toBeInTheDocument();
    expect(screen.queryByText(/prepared sample content/)).not.toBeInTheDocument();
  });

  it("shows the learner's title and 'Local audio', never the file name", async () => {
    const source = fakeSource({
      getTranscript: async () => asrTranscript,
      getEpisode: async (id) => ({
        ...testEpisode,
        id,
        title: "Practice clip",
        description: "Local audio",
        demo: undefined,
        audioProvenance: { kind: "user-provided", publishable: false, notes: "Yours." },
        audioUrl: "http://127.0.0.1:8790/episodes/x/audio",
      }),
    });
    renderPage({ source });
    await playButtons();
    expect(screen.getByRole("heading", { level: 1, name: "Practice clip" })).toBeInTheDocument();
    expect(screen.getByText("Local audio", { selector: "p" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/invented_private_interview|\.m4a/);
  });

  it("has no English controls and never requests a translation", async () => {
    const { provider, translate } = fakeTranslationProvider();
    renderPage({ source: asrSource(), translation: provider });
    const list = await screen.findByRole("list", { name: "Transcript" });
    await playButtons();
    expect(within(list).queryByRole("button", { name: "English" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /English/ })).not.toBeInTheDocument();
    await userEvent.keyboard("t");
    const shortcuts = screen.getByLabelText("Keyboard shortcuts");
    expect(shortcuts).not.toHaveTextContent("English");
    expect(shortcuts).toHaveTextContent("pinyin");
    expect(translate).not.toHaveBeenCalled();
  });

  it("keeps pinyin, editing and saving, with no translation on saved items", async () => {
    const { provider, translate } = fakeTranslationProvider();
    const store = new MemoryLearningStore();
    renderPage({ source: asrSource(), translation: provider, store });
    const line = await lineActions(1);

    const pinyin = line.getByRole("button", { name: "Pinyin" });
    expect(pinyin).not.toHaveAttribute("aria-disabled");
    await userEvent.click(pinyin);
    expect(await screen.findByText("dì èr jù。")).toBeInTheDocument();

    await userEvent.click(line.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    await userEvent.click(line.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect(await store.listItems()).toHaveLength(1));
    expect((await store.listItems())[0]).toMatchObject({
      text: "第二句。",
      pinyin: "dì èr jù。",
      translation: null,
      provenance: { transcriptKind: "asr", transcriptProvider: "funasr", corrected: false },
    });
    expect(translate).not.toHaveBeenCalled();
  });

  it("does not show structural review flags to learners", async () => {
    renderPage({ source: asrSource() });
    await playButtons();
    expect(
      screen.queryByText(/long_segment|long segment|May need review/i),
    ).not.toBeInTheDocument();
  });
});

describe("EpisodePage — Copy Chinese", () => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText, readText: vi.fn() },
    });
  });

  const copyIn = async (n: number) =>
    (await lineActions(n)).getByRole("button", { name: COPY_LABEL });

  it("copies the demo's displayed line, then the corrected text after an edit", async () => {
    const { provider, translate } = fakeTranslationProvider();
    renderPage({ translation: provider });
    await userEvent.click(await copyIn(1));
    expect(writeText).toHaveBeenLastCalledWith("第二句。");

    await userEvent.click((await lineActions(1)).getByRole("button", { name: "Edit" }));
    const input = screen.getByRole("textbox", { name: "Edit this line" });
    await userEvent.clear(input);
    await userEvent.type(input, "第二句话。");
    await userEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await userEvent.click(await copyIn(1));
    expect(writeText).toHaveBeenLastCalledWith("第二句话。");
    expect(translate).not.toHaveBeenCalled(); // copying never asks for a translation
  });

  it("works for real (ASR) transcripts, where English is hidden", async () => {
    const asrSource = fakeSource({
      getTranscript: async () => ({
        ...testTranscript,
        provenance: { ...testTranscript.provenance, kind: "asr" as const, provider: "funasr" },
      }),
    });
    const { provider, translate } = fakeTranslationProvider();
    renderPage({ source: asrSource, translation: provider });
    expect((await lineActions(0)).queryByRole("button", { name: "English" })).toBeNull();
    await userEvent.click(await copyIn(0));
    expect(writeText).toHaveBeenCalledWith("第一句。");
    expect(translate).not.toHaveBeenCalled();
  });

  it("isn't offered for mock (placeholder) transcripts", async () => {
    const mockSource = fakeSource({
      getTranscript: async () => ({
        ...testTranscript,
        provenance: { ...testTranscript.provenance, kind: "mock" as const, provider: "mock" },
      }),
    });
    renderPage({ source: mockSource });
    await playButtons();
    expect(screen.queryByRole("button", { name: COPY_LABEL })).not.toBeInTheDocument();
  });

  it("stores nothing: learner data and localStorage are unchanged", async () => {
    const store = new MemoryLearningStore();
    renderPage({ store });
    const before = JSON.stringify([await store.listItems(), await store.listCorrections()]);
    const keys = Object.keys(localStorage).sort().join();
    await userEvent.click(await copyIn(2));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([await store.listItems(), await store.listCorrections()])).toBe(before);
    expect(Object.keys(localStorage).sort().join()).toBe(keys);
  });
});
