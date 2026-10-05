import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { SearchField } from "./SearchField.tsx";

function Harness() {
  const [value, setValue] = useState("");
  return (
    <SearchField
      label="Search episodes"
      placeholder="Search titles"
      value={value}
      onChange={setValue}
    />
  );
}

describe("SearchField", () => {
  it("is a labelled search input with a Clear button only while there's text", async () => {
    render(<Harness />);
    const field = screen.getByRole("searchbox", { name: "Search episodes" });
    expect(field).toHaveAttribute("placeholder", "Search titles");
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
    await userEvent.type(field, "walk");
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(field).toHaveValue("");
    expect(field).toHaveFocus();
  });

  it("clears with Escape", async () => {
    render(<Harness />);
    const field = screen.getByRole("searchbox", { name: "Search episodes" });
    await userEvent.type(field, "walk{Escape}");
    expect(field).toHaveValue("");
  });
});
