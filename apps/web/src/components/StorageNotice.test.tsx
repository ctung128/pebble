import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/fixtures.tsx";
import { StorageNotice } from "./StorageNotice.tsx";

describe("StorageNotice", () => {
  it("stays hidden when storage works", async () => {
    renderWithProviders(<StorageNotice />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("explains session-only mode when storage is unavailable, and can be dismissed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderWithProviders(<StorageNotice />, {
      openStore: () => Promise.reject(new Error("blocked")),
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      /edits and learning items will only last until you close this tab/,
    );
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    warn.mockRestore();
  });
});
