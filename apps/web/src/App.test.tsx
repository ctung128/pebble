import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { EpisodeRoute, Layout, type AppMode } from "./App.tsx";
import { buildLearningItem } from "./features/learning/buildLearningItem.ts";
import { MemoryLearningStore } from "./features/learning/MemoryLearningStore.ts";
import { renderWithProviders, testEpisode, testTranscript } from "./test/fixtures.tsx";

function renderShell(mode: AppMode, route = "/", store = new MemoryLearningStore()) {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<Layout mode={mode} />}>
        <Route path="episodes/:episodeId" element={<EpisodeRoute />} />
        <Route path="*" element={<h1>Page content</h1>} />
        <Route index element={<h1>Page content</h1>} />
      </Route>
    </Routes>,
    { route, store },
  );
}

describe("Layout", () => {
  it("has a banner, main navigation and a main landmark with the page inside", () => {
    renderShell("demo");
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByRole("heading", { level: 1 })).toHaveTextContent(
      "Page content",
    );
    // The page's h1 is the only one: the wordmark is a link, not a heading.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Pebble" })).toHaveAttribute("href", "/");
  });

  it("shows the mode chip with its explanation", () => {
    renderShell("demo");
    expect(screen.getByText("Demo")).toHaveAttribute(
      "title",
      "Bundled sample content only. Nothing is uploaded or transcribed.",
    );
  });

  it("marks the current tab and keeps the Library tab's name plain", () => {
    renderShell("demo", "/items");
    const nav = screen.getByRole("navigation", { name: "Main" });
    const library = within(nav).getByRole("link", { name: "Library" });
    expect(library).toHaveAttribute("href", "/");
    expect(library).not.toHaveAttribute("aria-current");
    expect(within(nav).getByRole("link", { name: /Learning items/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("highlights Library on an episode page without claiming it is the current page", () => {
    renderShell("demo", "/episodes/test-001");
    const library = screen.getByRole("link", { name: "Library" });
    expect(library).not.toHaveAttribute("aria-current");
    expect(library).toHaveAttribute("data-section", "true");
  });

  it("shows the learning item count on the Learning items tab", async () => {
    const store = new MemoryLearningStore();
    await store.putItem(
      buildLearningItem({
        episode: testEpisode,
        transcript: testTranscript,
        segment: testTranscript.segments[0]!,
        correction: null,
        pinyin: null,
        translation: null,
      }),
    );
    renderShell("demo", "/", store);
    expect(await screen.findByRole("link", { name: /^Learning items\s*1$/ })).toBeInTheDocument();
  });

  it("has no Add audio button in the demo", () => {
    renderShell("demo");
    expect(screen.queryByRole("link", { name: "Add audio" })).not.toBeInTheDocument();
  });

  it("offers Add audio as the primary action in local mode", () => {
    renderShell("local");
    expect(screen.getByRole("link", { name: "Add audio" })).toHaveAttribute("href", "/process");
    expect(screen.getByText("Local")).toHaveAttribute(
      "title",
      "Runs with Pebble's worker on this computer. Your audio stays here.",
    );
  });

  it("puts an episode's keyboard shortcuts in the sidebar, not the page", async () => {
    renderShell("demo", "/episodes/test-001");
    const shortcuts = await screen.findByRole("region", { name: "Keyboard shortcuts" });
    const sidebar = screen.getByRole("navigation", { name: "Main" }).closest("header");
    expect(sidebar).toContainElement(shortcuts);
    expect(screen.getByRole("main")).not.toContainElement(shortcuts);
    expect(shortcuts).toHaveTextContent("play/pause");
  });
});
