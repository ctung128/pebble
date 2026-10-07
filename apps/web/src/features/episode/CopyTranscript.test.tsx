/** "Copy transcript": the whole displayed Chinese transcript as plain text. Invented text only. */
import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CURRENT_SCHEMA_VERSION } from "@pebble/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fakeSource,
  fakeTranslationProvider,
  renderWithProviders,
  testTranscript,
} from "../../test/fixtures.tsx";
import { MemoryLearningStore } from "../learning/MemoryLearningStore.ts";
import {
  COPY_FAILED,
  COPY_RESET_MS,
  COPY_TRANSCRIPT_HELP,
  transcriptPlainText,
} from "../reader/copyText.ts";
import { EpisodePage } from "./EpisodePage.tsx";

/** The test transcript's speakers are authored (A, B, A), so every line carries its label. */
const EXPECTED = "Speaker A: 第一句。\nSpeaker B: 第二句。\nSpeaker A: 第三句。";

let writeText: ReturnType<typeof vi.fn>;
let readText: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;
let translate: ReturnType<typeof fakeTranslationProvider>["translate"];
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  writeText = vi.fn(async () => {});
  readText = vi.fn(async () => "");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText, readText },
  });
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
    vi.spyOn(console, level),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const spy of consoleSpies) {
    expect(spy).not.toHaveBeenCalled(); // the transcript (or anything about copying) is never logged
    spy.mockRestore();
  }
  expect(readText).not.toHaveBeenCalled(); // the clipboard is never read
  expect(fetchSpy).not.toHaveBeenCalled(); // no network
  expect(translate).not.toHaveBeenCalled(); // and no translation provider
});

async function renderEpisode(options: Parameters<typeof renderWithProviders>[1] = {}) {
  const fake = fakeTranslationProvider();
  translate = fake.translate;
  renderWithProviders(<EpisodePage episodeId="test-001" />, {
    translation: fake.provider,
    ...options,
  });
  await screen.findByRole("list", { name: "Transcript" });
}

const menuButton = () => screen.getByRole("button", { name: "Transcript actions" });
/** Opens the transcript's ⋯ menu and returns its Copy transcript item. */
function copyItem() {
  if (menuButton().getAttribute("aria-expanded") !== "true") fireEvent.click(menuButton());
  return screen.getByRole("menuitem", { name: "Copy transcript" });
}

describe("Copy transcript", () => {
  it("sits in the transcript menu after Show English, with help that says what it copies", async () => {
    await renderEpisode();
    expect(screen.queryByRole("menuitem", { name: "Copy transcript" })).toBeNull();
    const copy = copyItem();
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual(["Show English", "Copy transcript"]);
    expect(copy).toHaveAttribute("title", COPY_TRANSCRIPT_HELP);
  });

  it("copies every line's Chinese, in order, one per line, and nothing else", async () => {
    await renderEpisode();
    await userEvent.click(copyItem());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(EXPECTED);
  });

  it("copies the same text with pinyin shown (pinyin is never included)", async () => {
    await renderEpisode();
    for (const row of screen.getAllByRole("button", { name: "Pinyin" })) await userEvent.click(row);
    expect(await screen.findAllByText(/dì yī jù/)).not.toHaveLength(0);
    await userEvent.click(copyItem());
    expect(writeText).toHaveBeenCalledWith(EXPECTED);
  });

  it("uses the learner's correction where a line was edited", async () => {
    const store = new MemoryLearningStore();
    await store.putCorrection({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      episodeId: "test-001",
      segmentId: "seg-2",
      originalText: "第二句。",
      correctedText: "第二句话。",
      updatedAt: "2026-10-05T00:00:00Z",
    });
    await renderEpisode({ store });
    await screen.findByText("第二句话。");
    await userEvent.click(copyItem());
    expect(writeText).toHaveBeenCalledWith(
      "Speaker A: 第一句。\nSpeaker B: 第二句话。\nSpeaker A: 第三句。",
    );
  });

  it("confirms with 'Transcript copied', then returns to normal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderEpisode();
    fireEvent.click(copyItem());
    // The menu closes; the confirmation shows beside its button.
    expect(
      await screen.findByText("Transcript copied", { selector: "[role=status]" }),
    ).toBeVisible();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(menuButton()).toHaveFocus();
    await act(async () => {
      vi.advanceTimersByTime(COPY_RESET_MS + 10);
    });
    expect(screen.queryByText("Transcript copied", { selector: "[role=status]" })).toBeNull();
  });

  it("works from the keyboard", async () => {
    await renderEpisode();
    menuButton().focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("menuitem", { name: "Show English" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Copy transcript" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(writeText).toHaveBeenCalledWith(EXPECTED);
  });

  it("explains a refused clipboard and offers the transcript, selected, to copy by hand", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    await renderEpisode();
    await userEvent.click(copyItem());
    expect(await screen.findByText(COPY_FAILED)).toBeInTheDocument();
    const field = screen.getByRole("textbox", { name: "Transcript text" });
    expect(field.tagName).toBe("TEXTAREA");
    expect(field).toHaveValue(EXPECTED);
    expect(field).toHaveAttribute("readonly");
    expect(field).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText(COPY_FAILED)).not.toBeInTheDocument();
    expect(menuButton()).toHaveFocus();
  });

  it("copies Chinese only when the transcript has no speaker labels", async () => {
    const source = fakeSource({
      getTranscript: async () => ({
        ...testTranscript,
        segments: testTranscript.segments.map((s) => ({ ...s, speaker: null })),
      }),
    });
    await renderEpisode({ source });
    await userEvent.click(copyItem());
    expect(writeText).toHaveBeenCalledWith("第一句。\n第二句。\n第三句。");
  });

  it("isn't offered for a preview (placeholder) transcript", async () => {
    const source = fakeSource({
      getTranscript: async () => ({
        ...testTranscript,
        provenance: { ...testTranscript.provenance, kind: "mock", provider: "mock" },
      }),
    });
    await renderEpisode({ source });
    fireEvent.click(menuButton());
    expect(screen.queryByRole("menuitem", { name: "Copy transcript" })).not.toBeInTheDocument();
  });

  it("isn't offered when the transcript has no lines", async () => {
    const fake = fakeTranslationProvider();
    translate = fake.translate;
    renderWithProviders(<EpisodePage episodeId="test-001" />, {
      translation: fake.provider,
      source: fakeSource({ getTranscript: async () => ({ ...testTranscript, segments: [] }) }),
    });
    expect(await screen.findByText("No transcript lines")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Copy transcript" })).not.toBeInTheDocument();
  });
});

describe("transcriptPlainText", () => {
  it("joins displayed lines with newlines, falling back to the transcript's text", () => {
    const lines = new Map([["seg-2", "改过。"]]);
    expect(transcriptPlainText(testTranscript.segments, (id) => lines.get(id))).toBe(
      "Speaker A: 第一句。\nSpeaker B: 改过。\nSpeaker A: 第三句。",
    );
  });

  it("stays Chinese only for lines without a speaker label, and repeats labels per line", () => {
    const segments = [
      { id: "a", text: "你好。", speaker: "A" },
      { id: "b", text: "我觉得可以。", speaker: "A" },
      { id: "c", text: "好，那我们开始吧。", speaker: "B" },
      { id: "d", text: "没有标注。", speaker: null },
    ];
    expect(transcriptPlainText(segments, () => undefined)).toBe(
      "Speaker A: 你好。\nSpeaker A: 我觉得可以。\nSpeaker B: 好，那我们开始吧。\n没有标注。",
    );
    const unlabelled = segments.map((s) => ({ ...s, speaker: null }));
    expect(transcriptPlainText(unlabelled, () => undefined)).toBe(
      "你好。\n我觉得可以。\n好，那我们开始吧。\n没有标注。",
    );
  });

  it("handles a very long transcript without dropping lines", () => {
    const segments = Array.from({ length: 5000 }, (_, i) => ({ id: `s${i}`, text: `第${i}句。` }));
    const text = transcriptPlainText(segments, () => undefined);
    expect(text.split("\n")).toHaveLength(5000);
    expect(text.endsWith("第4999句。")).toBe(true);
  });
});
