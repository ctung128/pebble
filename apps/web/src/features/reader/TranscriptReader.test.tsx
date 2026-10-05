import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { testTranscript } from "../../test/fixtures.tsx";
import type { LineActions, LineView } from "./lineView.ts";
import { plainLineView, TranscriptReader } from "./TranscriptReader.tsx";

const { segments } = testTranscript;

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

function renderReader(
  activeIndex: number,
  overrides: Record<string, Partial<LineView>> = {},
  actions = fakeActions(),
) {
  const lines = new Map(
    segments.map((s) => [s.id, { ...plainLineView(s), ...overrides[s.id] }] as const),
  );
  render(
    <TranscriptReader
      segments={segments}
      activeIndex={activeIndex}
      language="zh-CN"
      lines={lines}
      actions={actions}
      reviewDescriptionId="review-help"
    />,
  );
  return { actions, rows: screen.getAllByRole("button", { name: /^\d+:\d\d/ }) };
}

describe("TranscriptReader", () => {
  it("renders one play button per segment with time and text", () => {
    const { rows } = renderReader(-1);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent("0:03");
    expect(rows[1]).toHaveTextContent("第二句。");
  });

  it("marks only the active line with aria-current", () => {
    const { rows } = renderReader(1);
    expect(rows[1]).toHaveAttribute("aria-current", "true");
    expect(rows[0]).not.toHaveAttribute("aria-current");
  });

  it("reports the clicked segment", async () => {
    const { rows, actions } = renderReader(0);
    await userEvent.click(rows[2]!);
    expect(actions.select).toHaveBeenCalledWith(segments[2]);
  });

  it("exposes line actions as labelled, stateful buttons", async () => {
    const { actions } = renderReader(0, { "seg-1": { saved: true } });
    const pinyin = screen.getAllByRole("button", { name: "Pinyin" })[0]!;
    expect(pinyin).toHaveAttribute("aria-pressed", "false");
    expect(screen.getAllByRole("button", { name: "English" })[0]).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getAllByRole("button", { name: "Saved" })).toHaveLength(1);
    await userEvent.click(pinyin);
    expect(actions.togglePinyin).toHaveBeenCalledWith(segments[0]);
  });

  it("shows displayed text, pinyin and translation from the line view", () => {
    renderReader(0, {
      "seg-1": {
        text: "第一句话。",
        pinyin: { visible: true, status: "ready", text: "dì yī jù huà。" },
        translation: { open: true, forText: "第一句话。", status: "ready", text: "First line." },
      },
    });
    expect(screen.getByText("第一句话。")).toHaveAttribute("lang", "zh-CN");
    expect(screen.getByText("dì yī jù huà。")).toBeInTheDocument();
    expect(screen.getByText("First line.")).toHaveAttribute("lang", "en");
  });

  it("marks lines that may need review and links the explanation", () => {
    const { rows } = renderReader(0, { "seg-2": { needsReview: true } });
    expect(screen.getByText("May need review")).toBeInTheDocument();
    expect(rows[1]).toHaveAttribute("aria-describedby", "review-help");
    expect(rows[0]).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText(/illustrative/i)).not.toBeInTheDocument();
  });

  it("shows an empty state for a transcript with no lines", () => {
    render(
      <TranscriptReader
        segments={[]}
        activeIndex={-1}
        language="zh-CN"
        lines={new Map()}
        actions={fakeActions()}
        reviewDescriptionId="review-help"
      />,
    );
    expect(screen.getByText("No transcript lines")).toBeInTheDocument();
  });

  it("shows the transcript's speaker letter on every line, read as 'Speaker A'", () => {
    const { rows } = renderReader(-1);
    expect(rows[0]).toHaveAccessibleName(/^0:00\s*Speaker A\s*第一句。$/);
    expect(rows[1]).toHaveAccessibleName(/^0:03\s*Speaker B\s*第二句。$/);
  });

  it("repeats the letter for the same speaker and leaves an empty slot without one", () => {
    const turns = segments.map((s, i) => ({ ...s, speaker: i === 2 ? null : "A" }));
    const lines = new Map(turns.map((s) => [s.id, plainLineView(s)] as const));
    render(
      <TranscriptReader
        segments={turns}
        activeIndex={-1}
        language="zh-CN"
        lines={lines}
        actions={fakeActions()}
        reviewDescriptionId="review-help"
      />,
    );
    expect(screen.getAllByText("Speaker")).toHaveLength(2);
  });
});
