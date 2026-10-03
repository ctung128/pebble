import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "@pebble/schema";
import { SourceError } from "../../data/EpisodeSource.ts";
import { fakeSource, renderWithProviders } from "../../test/fixtures.tsx";
import { MemoryLearningStore } from "../learning/MemoryLearningStore.ts";
import { LibraryPage } from "./LibraryPage.tsx";

describe("LibraryPage", () => {
  it("links each episode and flags placeholder audio", async () => {
    renderWithProviders(<LibraryPage />);
    const link = await screen.findByRole("link", { name: /Test episode/ });
    expect(link).toHaveAttribute("href", "/episodes/test-001");
    expect(screen.getByText("Placeholder audio")).toBeInTheDocument();
  });

  it("shows an empty state", async () => {
    renderWithProviders(<LibraryPage />, {
      source: fakeSource({ listEpisodes: async () => [] }),
    });
    expect(await screen.findByText("No episodes yet")).toBeInTheDocument();
  });

  it("shows an error state", async () => {
    renderWithProviders(<LibraryPage />, {
      source: fakeSource({
        listEpisodes: async () => {
          throw new SourceError("NETWORK", "manifest.json returned HTTP 500.");
        },
      }),
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load content");
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
    renderWithProviders(<LibraryPage />, { store });

    await userEvent.click(await screen.findByRole("button", { name: "Reset demo data" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await store.listCorrections()).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Reset demo data" }));
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(async () => expect(await store.listCorrections()).toEqual([]));
    expect(screen.getByText(/Demo data reset/)).toBeInTheDocument();
  });
});
