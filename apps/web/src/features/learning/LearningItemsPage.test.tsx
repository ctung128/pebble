import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "@pebble/schema";
import { renderWithProviders, testEpisode, testTranscript } from "../../test/fixtures.tsx";
import { buildLearningItem } from "./buildLearningItem.ts";
import { LearningItemsPage } from "./LearningItemsPage.tsx";

const downloadText = vi.hoisted(() => vi.fn());
vi.mock("../../lib/downloadText.ts", () => ({ downloadText }));
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

  it("offers no reset control in local mode", async () => {
    vi.stubGlobal("__PEBBLE_LOCAL__", true);
    try {
      renderWithProviders(<LearningItemsPage />, { store: await storeWithItem() });
      expect(await screen.findByText("第二句。")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Remove all edits/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Reset/ })).not.toBeInTheDocument();
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

  describe("search", () => {
    /** Invented items across two episodes; one edited, one whose source was deleted. */
    async function searchableStore() {
      const store = new MemoryLearningStore();
      const other = {
        ...testEpisode,
        id: "ep-bbbbbbbbbbbb",
        title: "Other walk",
        titleZh: undefined,
      };
      await store.putItem({
        ...buildLearningItem({
          episode: testEpisode,
          transcript: testTranscript,
          segment: testTranscript.segments[1]!,
          correction: null,
          pinyin: "dì èr jù。",
          translation: "The second sentence.",
          id: "item-second",
        }),
        note: "remember this one",
      });
      await store.putItem(
        buildLearningItem({
          episode: other,
          transcript: { ...testTranscript, episodeId: other.id },
          segment: testTranscript.segments[0]!,
          correction: {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            episodeId: other.id,
            segmentId: "seg-1",
            originalText: "第一句。",
            correctedText: "第一句话。",
            updatedAt: "2026-10-05T00:00:00Z",
          },
          pinyin: null,
          translation: null,
          id: "item-edited",
        }),
      );
      await store.putItem({
        ...buildLearningItem({
          episode: { ...testEpisode, id: "ep-cccccccccccc", title: "Gone episode" },
          transcript: { ...testTranscript, episodeId: "ep-cccccccccccc" },
          segment: testTranscript.segments[2]!,
          correction: null,
          pinyin: null,
          translation: null,
          id: "item-gone",
        }),
        sourceDeletedAt: "2026-10-05T12:00:00.000Z",
      });
      return store;
    }

    async function renderSearch() {
      renderWithProviders(<LearningItemsPage />, { store: await searchableStore() });
      await screen.findByText("第二句。");
      return screen.getByRole("searchbox", { name: "Search learning items" });
    }
    // Only the item cards and episode groups (not the Anki panel's steps or heading).
    const groups = () => [...document.querySelectorAll('section[aria-labelledby^="group-"]')];
    const cards = () =>
      groups().flatMap((g) => [...g.querySelectorAll("li")].map((li) => li.textContent ?? ""));
    const groupTitles = () => groups().map((g) => g.querySelector("h2")?.textContent);

    it.each([
      ["Chinese", "第二", "第二句。"],
      ["pinyin without tone marks", "di er", "第二句。"],
      ["English, any case", "SECOND SENTENCE", "第二句。"],
      ["a note", "remember", "第二句。"],
      ["the original of an edited line", "第一句。", "第一句话。"],
      ["the episode title saved with it", "other walk", "第一句话。"],
      ["a deleted source's saved title", "Gone episode", "第三句。"],
    ])("finds an item by %s", async (_, query, chinese) => {
      const field = await renderSearch();
      await userEvent.type(field, query);
      expect(cards()).toHaveLength(1);
      expect(cards()[0]).toContain(chinese);
    });

    it("hides episode groups with no matches and counts what's shown", async () => {
      const field = await renderSearch();
      expect(groupTitles()).toHaveLength(3);
      await userEvent.type(field, "second");
      expect(groupTitles()).toHaveLength(1);
      expect(screen.getAllByText("1 of 3 items")[0]).toBeInTheDocument();
      expect(
        await screen.findByText("1 of 3 items", { selector: "[role=status]" }, { timeout: 2000 }),
      ).toBeInTheDocument();
    });

    it("doesn't search anything the item doesn't store", async () => {
      const field = await renderSearch();
      await userEvent.type(field, "测试节目"); // the source's current Chinese title, not on the item
      expect(screen.getByText("No learning items match “测试节目”.")).toBeInTheDocument();
      expect(cards()).toHaveLength(0);
      // The × in the field and the button in the message do the same thing.
      const [, inMessage] = screen.getAllByRole("button", { name: "Clear search" });
      await userEvent.click(inMessage!);
      expect(cards()).toHaveLength(3);
    });

    it("still exports every item while searching", async () => {
      const field = await renderSearch();
      await userEvent.type(field, "second");
      await userEvent.click(screen.getByRole("button", { name: "Export CSV for Anki" }));
      await waitFor(() => expect(downloadText).toHaveBeenCalled());
      const csv = downloadText.mock.lastCall![1] as string;
      expect(csv).toContain("第二句。");
      expect(csv).toContain("第一句话。");
      expect(csv).toContain("第三句。");
    });

    it("isn't offered when there are no items", async () => {
      renderWithProviders(<LearningItemsPage />);
      expect(await screen.findByText("No learning items yet")).toBeInTheDocument();
      expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    });
  });
});
