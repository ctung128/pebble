import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SourceError } from "../../data/EpisodeSource.ts";
import { fakeSource, renderWithProviders } from "../../test/fixtures.tsx";
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

  it("heads the page plainly and numbers each row with its titles and facts", async () => {
    renderWithProviders(<LibraryPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Library" })).toBeInTheDocument();
    expect(screen.queryByText(/01 — Library/)).not.toBeInTheDocument();
    expect(screen.getByText(/Listen to Mandarin audio/)).toBeInTheDocument(); // demo intro stays
    expect(await screen.findByText("1 episode")).toBeInTheDocument();

    const [row] = within(screen.getByRole("list", { name: "Episodes" })).getAllByRole("listitem");
    expect(row).toHaveTextContent("01");
    expect(row).toHaveTextContent("测试节目");
    // Covers are hidden; the title data they'd use is untouched.
    expect(within(row!).queryByText("测")).not.toBeInTheDocument();
    expect(row).toHaveTextContent("0:09");
    // One link per row (the title, covering the row) and no separate Open action.
    expect(within(row!).getAllByRole("link")).toHaveLength(1);
    expect(row).not.toHaveTextContent(/\bOpen\b/);
  });

  it("leaves resetting demo data to the Learning items page", async () => {
    renderWithProviders(<LibraryPage />);
    await screen.findByRole("link", { name: /Test episode/ });
    expect(screen.queryByRole("button", { name: "Reset demo data" })).not.toBeInTheDocument();
  });
});
