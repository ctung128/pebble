import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
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
