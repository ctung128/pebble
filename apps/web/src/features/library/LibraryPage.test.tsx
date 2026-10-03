import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { EpisodeSource } from "../../data/EpisodeSource.ts";
import { SourceError } from "../../data/EpisodeSource.ts";
import { SourceProvider } from "../../data/SourceContext.tsx";
import { fakeSource } from "../../test/fixtures.ts";
import { LibraryPage } from "./LibraryPage.tsx";

function renderLibrary(source: EpisodeSource) {
  render(
    <SourceProvider source={source}>
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>
    </SourceProvider>,
  );
}

describe("LibraryPage", () => {
  it("links each episode and flags placeholder audio", async () => {
    renderLibrary(fakeSource());
    const link = await screen.findByRole("link", { name: /Test episode/ });
    expect(link).toHaveAttribute("href", "/episodes/test-001");
    expect(screen.getByText("Placeholder audio")).toBeInTheDocument();
  });

  it("shows an empty state", async () => {
    renderLibrary(fakeSource({ listEpisodes: async () => [] }));
    expect(await screen.findByText("No episodes yet")).toBeInTheDocument();
  });

  it("shows an error state", async () => {
    renderLibrary(
      fakeSource({
        listEpisodes: async () => {
          throw new SourceError("NETWORK", "manifest.json returned HTTP 500.");
        },
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load content");
  });
});
