import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LearningItem } from "@pebble/schema";
import {
  fakeTranslationProvider,
  renderWithProviders,
  testEpisode,
  testTranscript,
} from "../../test/fixtures.tsx";
import { AnkiExportPanel, KEEP_A_COPY } from "./AnkiExportPanel.tsx";
import { ANKI_BACK_TEMPLATE } from "./ankiCsv.ts";
import { buildLearningItem } from "./buildLearningItem.ts";
import { MemoryLearningStore } from "./MemoryLearningStore.ts";

const downloadText = vi.hoisted(() => vi.fn());
vi.mock("../../lib/downloadText.ts", () => ({ downloadText }));

const item = (index: number, overrides: Partial<LearningItem> = {}): LearningItem => ({
  ...buildLearningItem({
    episode: testEpisode,
    transcript: testTranscript,
    segment: testTranscript.segments[index]!,
    correction: null,
    pinyin: null,
    translation: null,
    id: `item-${index}`,
  }),
  ...overrides,
});

const exportButton = () => screen.getByRole("button", { name: "Export CSV for Anki" });
const exportedCsv = () => downloadText.mock.lastCall?.[1] as string;

describe("AnkiExportPanel", () => {
  it("keeps import guidance in one collapsed disclosure, each fact once", () => {
    const { container } = renderWithProviders(<AnkiExportPanel items={[item(0)]} />);
    const help = container.querySelector("details")!;
    expect(help).not.toHaveAttribute("open");
    expect(within(help).getByText("How to import into Anki").tagName).toBe("SUMMARY");
    expect(screen.queryByText(/In Anki, import this file/)).not.toBeInTheDocument();
    // Guidance appears only inside the disclosure, once each.
    expect(within(help).getByText(KEEP_A_COPY)).toBeInTheDocument();
    expect(screen.getAllByText(KEEP_A_COPY)).toHaveLength(1);
    expect(screen.getAllByText(/Translation → Translation/)).toHaveLength(1);
    expect(screen.getAllByText(/\{\{#Translation\}\}/)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Export CSV for Anki" })).toBeEnabled();
    expect(screen.queryByText(/downloaded successfully/)).not.toBeInTheDocument();
  });

  it("uses a native disclosure, so the browser gives it keyboard and screen-reader support", async () => {
    const { container } = renderWithProviders(<AnkiExportPanel items={[item(0)]} />);
    const help = container.querySelector("details")!;
    const summary = screen.getByText("How to import into Anki");
    expect(help.firstElementChild).toBe(summary);
    await userEvent.click(summary);
    expect(help).toHaveAttribute("open");
  });

  it("offers expandable import help with the back template", async () => {
    renderWithProviders(<AnkiExportPanel items={[item(0)]} />);
    await userEvent.click(screen.getByText("How to import into Anki"));
    expect(screen.getByText(/Translation → Translation/)).toBeVisible();
    expect(screen.getByText(/\{\{#Translation\}\}/)).toBeVisible();
  });

  it("includes English and pinyin automatically for items saved without them", async () => {
    const store = new MemoryLearningStore();
    const { provider, translate } = fakeTranslationProvider();
    renderWithProviders(<AnkiExportPanel items={[item(0), item(1)]} />, {
      store,
      translation: provider,
    });
    expect(translate).not.toHaveBeenCalled(); // nothing is fetched before export

    await userEvent.click(exportButton());
    await screen.findByText("✓ CSV downloaded successfully.");
    expect(exportedCsv()).toContain("第一句。,dì yī jù。,The first sentence.,");
    expect(exportedCsv()).toContain("第二句。,dì èr jù。,The second sentence.,");
    expect(translate).toHaveBeenCalledTimes(2);
    // Resolved translations are kept on the learning items.
    await waitFor(async () =>
      expect((await store.listItems()).map((i) => [i.pinyin, i.translation]).sort()).toEqual([
        ["dì yī jù。", "The first sentence."],
        ["dì èr jù。", "The second sentence."],
      ]),
    );
  });

  it("keeps an existing translation and does not re-request it", async () => {
    const { provider, translate } = fakeTranslationProvider();
    renderWithProviders(<AnkiExportPanel items={[item(0, { translation: "Already here." })]} />, {
      translation: provider,
    });
    await userEvent.click(exportButton());
    await screen.findByText("✓ CSV downloaded successfully.");
    expect(exportedCsv()).toContain(",Already here.,");
    expect(translate).not.toHaveBeenCalled();
  });

  it("says when edited lines are exported without English", async () => {
    const edited = item(0, {
      text: "第一句话。",
      originalText: "第一句。",
      provenance: { ...item(0).provenance, corrected: true },
    });
    renderWithProviders(<AnkiExportPanel items={[edited, item(1)]} />);
    await userEvent.click(exportButton());
    expect(await screen.findByText(/1 edited line exported without English/)).toBeInTheDocument();
    // Pinyin is generated for the edited text; Translation stays blank, columns intact.
    expect(exportedCsv()).toContain("第一句话。,dì yī jù huà。,,");
  });

  it("still exports when translations can't be loaded, and says so", async () => {
    const failing = fakeTranslationProvider({ fail: true });
    renderWithProviders(<AnkiExportPanel items={[item(0)]} />, { translation: failing.provider });
    await userEvent.click(exportButton());
    expect(await screen.findByText("✓ CSV downloaded successfully.")).toBeInTheDocument();
    expect(screen.getByText(/1 item exported without English/)).toBeInTheDocument();
  });

  it("downloads UTF-8 CSV and separates success from the template reminder", async () => {
    renderWithProviders(<AnkiExportPanel items={[item(0)]} />);
    await userEvent.click(exportButton());
    await screen.findByText("✓ CSV downloaded successfully.");
    expect(downloadText).toHaveBeenLastCalledWith(
      expect.stringMatching(/^pebble-learning-items-\d{4}-\d{2}-\d{2}\.csv$/),
      expect.any(String),
      "text/csv;charset=utf-8",
    );
    expect(screen.getByText(/Anki card template setup is a one-time step/)).toBeInTheDocument();
  });

  it("reports a failed export", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    downloadText.mockImplementationOnce(() => {
      throw new Error("blocked");
    });
    renderWithProviders(<AnkiExportPanel items={[item(0)]} />);
    await userEvent.click(exportButton());
    expect(await screen.findByText("Couldn’t create the CSV file. Try again.")).toBeInTheDocument();
    expect(screen.queryByText(/downloaded successfully/)).not.toBeInTheDocument();
    warn.mockRestore();
  });

  it("disables export with no items", () => {
    renderWithProviders(<AnkiExportPanel items={[]} />);
    expect(exportButton()).toBeDisabled();
  });
});

describe("Anki docs", () => {
  it("show the same Back Template as the app", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    // Vitest runs from apps/web; jsdom's import.meta.url isn't a file: URL.
    const docs = readFileSync(resolve(process.cwd(), "../../docs/ANKI_EXPORT.md"), "utf8");
    expect(docs).toContain(ANKI_BACK_TEMPLATE);
  });
});
