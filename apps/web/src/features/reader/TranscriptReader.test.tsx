import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { testTranscript } from "../../test/fixtures.ts";
import { TranscriptReader } from "./TranscriptReader.tsx";

const { segments } = testTranscript;

function renderReader(activeIndex: number, onSelectSegment = vi.fn()) {
  render(
    <TranscriptReader
      segments={segments}
      activeIndex={activeIndex}
      language="zh-CN"
      onSelectSegment={onSelectSegment}
    />,
  );
  return { onSelectSegment, rows: screen.getAllByRole("button") };
}

describe("TranscriptReader", () => {
  it("renders one button per segment with time and text", () => {
    const { rows } = renderReader(-1);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent("0:03");
    expect(rows[1]).toHaveTextContent("第二句。");
  });

  it("marks only the active line with aria-current", () => {
    const { rows } = renderReader(1);
    expect(rows[1]).toHaveAttribute("aria-current", "true");
    expect(rows[0]).not.toHaveAttribute("aria-current");
    expect(rows[0]).toHaveAttribute("data-state", "past");
    expect(rows[2]).toHaveAttribute("data-state", "upcoming");
  });

  it("marks nothing active before the first line", () => {
    const { rows } = renderReader(-1);
    for (const row of rows) expect(row).not.toHaveAttribute("aria-current");
  });

  it("reports the clicked segment", async () => {
    const { rows, onSelectSegment } = renderReader(0);
    await userEvent.click(rows[2]!);
    expect(onSelectSegment).toHaveBeenCalledWith(segments[2]);
  });

  it("tags Chinese text with its language", () => {
    renderReader(0);
    expect(screen.getByText("第一句。")).toHaveAttribute("lang", "zh-CN");
  });

  it("shows an empty state for a transcript with no lines", () => {
    render(
      <TranscriptReader
        segments={[]}
        activeIndex={-1}
        language="zh-CN"
        onSelectSegment={vi.fn()}
      />,
    );
    expect(screen.getByText("No transcript lines")).toBeInTheDocument();
  });
});
