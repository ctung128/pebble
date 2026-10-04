import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, testEpisode, testTranscript } from "../../test/fixtures.tsx";
import { buildLearningItem } from "./buildLearningItem.ts";
import { LearningItemsPage, SOURCE_DELETED_HELP, STORAGE_NOTE } from "./LearningItemsPage.tsx";
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
  it("says where items are stored and how to keep a copy", async () => {
    renderWithProviders(<LearningItemsPage />);
    expect(await screen.findByText(STORAGE_NOTE)).toBeInTheDocument();
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
    expect(screen.getByDisplayValue("kept note")).toBeInTheDocument();
    expect(screen.getByText("Source deleted")).toBeInTheDocument();
    expect(screen.getByText(SOURCE_DELETED_HELP)).toBeInTheDocument();
    expect(screen.getByText(/Test episode · 0:03/)).toBeInTheDocument();
    expect(screen.queryByText(/· source deleted/)).not.toBeInTheDocument(); // the badge says it
    expect(screen.queryByRole("link", { name: /Test episode/ })).not.toBeInTheDocument();
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
    const note = await screen.findByRole("textbox", { name: "Note" });
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
});
