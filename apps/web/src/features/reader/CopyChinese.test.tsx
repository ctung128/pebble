/** "Copy Chinese": a local clipboard action on each transcript line. Invented text only. */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testTranscript } from "../../test/fixtures.tsx";
import { COPY_FAILED, COPY_HELP, COPY_LABEL, COPY_RESET_MS } from "./copyText.ts";
import type { LineActions, LineView } from "./lineView.ts";
import { plainLineView, TranscriptReader } from "./TranscriptReader.tsx";

const { segments } = testTranscript;
const first = segments[0]!;
const EDITED = "这是改过的一句话。"; // invented

function fakeActions(): LineActions {
  return {
    select: vi.fn(),
    togglePinyin: vi.fn(),
    retryPinyin: vi.fn(),
    toggleTranslation: vi.fn(),
    retryTranslation: vi.fn(),
    toggleSave: vi.fn(),
    confirmUnsave: vi.fn(),
    cancelUnsave: vi.fn(),
    startEdit: vi.fn(),
    cancelEdit: vi.fn(),
    saveEdit: vi.fn(() => "saved" as const),
    revert: vi.fn(),
    toggleOriginal: vi.fn(),
  };
}

function renderReader({
  showCopy = true,
  firstLine = {},
  actions = fakeActions(),
}: { showCopy?: boolean; firstLine?: Partial<LineView>; actions?: LineActions } = {}) {
  const lines = new Map(
    segments.map(
      (s) => [s.id, { ...plainLineView(s), ...(s.id === first.id ? firstLine : {}) }] as const,
    ),
  );
  render(
    <TranscriptReader
      segments={segments}
      activeIndex={0}
      language="zh-CN"
      lines={lines}
      actions={actions}
      reviewDescriptionId="review-help"
      showCopy={showCopy}
    />,
  );
  return actions;
}

const firstGroup = () => screen.getAllByRole("group", { name: /^Line at / })[0]!;
const copyButton = () => within(firstGroup()).getByRole("button", { name: COPY_LABEL });

let writeText: ReturnType<typeof vi.fn>;
let readText: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;
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
    expect(spy).not.toHaveBeenCalled(); // nothing about copying (or its text) is ever logged
    spy.mockRestore();
  }
  expect(readText).not.toHaveBeenCalled(); // the clipboard is never read
  expect(fetchSpy).not.toHaveBeenCalled(); // no network
});

describe("Copy Chinese", () => {
  it("is a named button with the help text, beside the other line actions", () => {
    renderReader();
    const button = copyButton();
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute("title", COPY_HELP);
    expect(COPY_HELP).toBe(
      "Copies this line's Chinese text to your clipboard. Pasting it into another service may send it there.",
    );
  });

  it("copies exactly the displayed text, never the time or anything else", async () => {
    renderReader();
    await userEvent.click(copyButton());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(first.text);
  });

  it("copies the corrected text of an edited line, not the original", async () => {
    renderReader({
      firstLine: {
        text: EDITED,
        correction: {
          schemaVersion: "1.6",
          episodeId: "test-001",
          segmentId: first.id,
          originalText: first.text,
          correctedText: EDITED,
          updatedAt: "2026-10-04T00:00:00Z",
        },
      },
    });
    await userEvent.click(copyButton());
    expect(writeText).toHaveBeenCalledWith(EDITED);
    expect(writeText).not.toHaveBeenCalledWith(first.text);
  });

  it("announces Copied, then returns to normal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderReader();
    fireEvent.click(copyButton());
    const status = within(firstGroup()).getByRole("status");
    expect(await within(firstGroup()).findByText("Copied")).toBe(status);
    expect(copyButton()).toHaveAttribute("title", "Copied");
    await act(async () => {
      vi.advanceTimersByTime(COPY_RESET_MS + 10);
    });
    expect(status).toHaveTextContent("");
    expect(copyButton()).toHaveAttribute("title", COPY_HELP);
  });

  it("works from the keyboard (Enter and Space)", async () => {
    renderReader();
    copyButton().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("explains a refused clipboard and offers the line, selected, to copy by hand", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    renderReader();
    await userEvent.click(copyButton());
    expect(await screen.findByText(COPY_FAILED)).toBeInTheDocument();
    expect(COPY_FAILED).toBe("Couldn't copy. Select the text and copy it manually.");
    const field = screen.getByRole("textbox", { name: "Chinese text for this line" });
    expect(field).toHaveValue(first.text);
    expect(field).toHaveAttribute("readonly");
    expect(field).toHaveFocus();
    expect((field as HTMLInputElement).selectionEnd).toBe(first.text.length);

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText(COPY_FAILED)).not.toBeInTheDocument();
    expect(copyButton()).toHaveFocus();
  });

  it("falls back the same way when the Clipboard API is missing", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    renderReader();
    await userEvent.click(copyButton());
    expect(await screen.findByText(COPY_FAILED)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText(COPY_FAILED)).not.toBeInTheDocument();
  });

  it("doesn't select or play the line, or touch any other line action", async () => {
    const actions = renderReader();
    await userEvent.click(copyButton());
    for (const fn of Object.values(actions)) expect(fn).not.toHaveBeenCalled();
  });

  it("isn't shown unless enabled", () => {
    renderReader({ showCopy: false });
    expect(screen.queryByRole("button", { name: COPY_LABEL })).not.toBeInTheDocument();
  });
});
