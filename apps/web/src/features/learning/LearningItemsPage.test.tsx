import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
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
