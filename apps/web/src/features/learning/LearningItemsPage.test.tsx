import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "@pebble/schema";
import { renderWithProviders, testEpisode, testTranscript } from "../../test/fixtures.tsx";
import { buildLearningItem } from "./buildLearningItem.ts";
import { LearningItemsPage } from "./LearningItemsPage.tsx";
import { MemoryLearningStore } from "./MemoryLearningStore.ts";

async function storeWithItem() {
  const store = new MemoryLearningStore();
  await store.putItem(
    buildLearningItem({
      episode: testEpisode,
      transcript: testTranscript,
      segment: testTranscript.segments[1]!,
      correction: null,
      pinyin: "dì èr jù。",
      translation: "The second sentence.",
    }),
  );
  return store;
}

describe("LearningItemsPage", () => {
  it("keeps the header to the title and count, without explanatory copy", async () => {
    renderWithProviders(<LearningItemsPage />, { store: await storeWithItem() });
    await screen.findByText("第二句。");
    expect(screen.queryByText(/02 — Learning items/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Lines you saved while listening/)).not.toBeInTheDocument();
    // The storage fact lives once, inside the Anki import help.
    expect(screen.getAllByText(/outside this browser/)).toHaveLength(1);
    expect(screen.queryByText(/saved in this browser/)).not.toBeInTheDocument();
  });

  it("resets demo data only after confirmation", async () => {
    const store = new MemoryLearningStore();
    await store.putCorrection({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      episodeId: "test-001",
      segmentId: "seg-1",
      originalText: "第一句。",
      correctedText: "第一句话。",
      updatedAt: "2026-10-03T00:00:00Z",
    });
    renderWithProviders(<LearningItemsPage />, { store });

    await userEvent.click(await screen.findByRole("button", { name: "Reset demo data" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await store.listCorrections()).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Reset demo data" }));
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(async () => expect(await store.listCorrections()).toEqual([]));
    expect(screen.getByText(/Demo data reset/)).toBeInTheDocument();
  });

  it("names the reset control for what it removes in local mode", async () => {
    vi.stubGlobal("__PEBBLE_LOCAL__", true);
    try {
      renderWithProviders(<LearningItemsPage />, { store: await storeWithItem() });
      expect(
        await screen.findByRole("button", { name: "Remove all edits and learning items" }),
      ).toBeInTheDocument();
      expect(screen.queryByText(/demo data/i)).not.toBeInTheDocument();
    } finally {
      vi.stubGlobal("__PEBBLE_LOCAL__", false);
    }
  });

  it("marks items whose source was deleted, without a link back", async () => {
    const store = new MemoryLearningStore();
    const [stored] = await (await storeWithItem()).listItems();
    await store.putItem({
      ...stored!,
      note: "kept note",
      sourceDeletedAt: "2026-10-04T12:00:00.000Z",
    });
    renderWithProviders(<LearningItemsPage />, { store });
    expect(await screen.findByText("第二句。")).toBeInTheDocument();
    expect(screen.getByText("dì èr jù。")).toBeInTheDocument();
    expect(screen.getByText("The second sentence.")).toBeInTheDocument();
    expect(screen.getByText("kept note")).toBeInTheDocument();
    expect(screen.getByText("Source deleted")).toBeInTheDocument();
    expect(screen.queryByText(/This item is saved/)).not.toBeInTheDocument();
    expect(screen.getByText(/Test episode · 0:03/)).toBeInTheDocument();
    expect(screen.queryByText(/· source deleted/)).not.toBeInTheDocument(); // the badge says it
    expect(screen.queryByRole("link", { name: /Test episode/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Go to line" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export CSV for Anki" })).toBeEnabled();
  });

  it("shows an empty state and disables export", async () => {
    renderWithProviders(<LearningItemsPage />);
    expect(await screen.findByText("No learning items yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export CSV for Anki" })).toBeDisabled();
  });

  it("lists items with a link back to the source line", async () => {
    renderWithProviders(<LearningItemsPage />, { store: await storeWithItem() });
    expect(await screen.findByText("第二句。")).toHaveAttribute("lang", "zh-CN");
    expect(screen.getByText("dì èr jù。")).toBeInTheDocument();
    expect(screen.getByText("The second sentence.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Test episode · 0:03" })).toHaveAttribute(
      "href",
      "/episodes/test-001?segment=seg-2",
    );
    expect(screen.getByRole("button", { name: "Export CSV for Anki" })).toBeEnabled();
  });

  it("edits and saves a note", async () => {
    const store = await storeWithItem();
    renderWithProviders(<LearningItemsPage />, { store });
    const edit = await screen.findByRole("button", { name: "Edit note" });
    expect(screen.queryByRole("textbox", { name: "Note" })).not.toBeInTheDocument();
    await userEvent.click(edit);
    expect(edit).toHaveAttribute("aria-expanded", "true");
    const note = screen.getByRole("textbox", { name: "Note" });
    const save = screen.getByRole("button", { name: "Save note" });
    expect(save).toBeDisabled();
    await userEvent.type(note, "第二 = second{Enter}heard twice");
    await userEvent.click(save);
    expect(screen.getByText("Note saved")).toBeInTheDocument();
    await waitFor(async () =>
      expect((await store.listItems())[0]?.note).toBe("第二 = second\nheard twice"),
    );
  });

  it("deletes an item only after confirmation", async () => {
    const store = await storeWithItem();
    renderWithProviders(<LearningItemsPage />, { store });
    const card = (await screen.findByText("第二句。")).closest("li")!;
    await userEvent.click(within(card).getByRole("button", { name: "Delete" }));
    expect(within(card).getByText("Delete this learning item?")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("No learning items yet")).toBeInTheDocument();
    await waitFor(async () => expect(await store.listItems()).toEqual([]));
  });

  it("groups items under their episode with its Chinese title and a count", async () => {
    renderWithProviders(<LearningItemsPage />, { store: await storeWithItem() });
    expect(screen.getByRole("heading", { level: 1, name: "Learning items" })).toBeInTheDocument();
    const group = await screen.findByRole("region", { name: /Test episode/ });
    expect(within(group).getByRole("heading", { level: 2 })).toHaveTextContent("Test episode");
    expect(await within(group).findByText("测试节目")).toHaveAttribute("lang", "zh-CN");
    expect(within(group).getByText("1 item")).toBeInTheDocument();
  });

  it("offers Go to line, which cues the line in its episode", async () => {
    renderWithProviders(<LearningItemsPage />, { store: await storeWithItem() });
    expect(await screen.findByRole("link", { name: "Go to line" })).toHaveAttribute(
      "href",
      "/episodes/test-001?segment=seg-2",
    );
  });

  it("has no copy action on cards (copying lives in the reader)", async () => {
    renderWithProviders(<LearningItemsPage />, { store: await storeWithItem() });
    await screen.findByText("第二句。");
    expect(screen.queryByRole("button", { name: /Copy/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit note" })).toBeInTheDocument();
  });
});
