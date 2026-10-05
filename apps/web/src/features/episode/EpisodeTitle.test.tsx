import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { episodeTitleProblem } from "./episodeRename.ts";
import { EpisodeTitle } from "./EpisodeTitle.tsx";

function renderTitle(onRename?: (title: string) => Promise<void>) {
  render(<EpisodeTitle title="Morning walk" onRename={onRename} />);
}

const pencil = () => screen.getByRole("button", { name: "Rename episode" });
const field = () => screen.getByRole("textbox", { name: "Episode title" });

describe("episodeTitleProblem", () => {
  it.each([
    ["", "Give the episode a title."],
    ["   ", "Give the episode a title."],
    ["x".repeat(201), "Keep the title to 200 characters or fewer."],
    ["two\nlines", "Keep the title on one line."],
    ["a b", "Keep the title on one line."],
  ])("refuses %j", (title, problem) => {
    expect(episodeTitleProblem(title)).toBe(problem);
  });

  it.each([
    "  Morning walk  ",
    "听".repeat(200), // counted by character, not UTF-16 unit
    "😀".repeat(200),
    "第二期：慢慢听 — Part 2 (rev. #3)!",
  ])("accepts %j", (title) => {
    expect(episodeTitleProblem(title)).toBeNull();
  });
});

describe("EpisodeTitle", () => {
  it("is a plain heading when renaming isn't offered", () => {
    renderTitle();
    expect(screen.getByRole("heading", { level: 1, name: "Morning walk" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename episode" })).not.toBeInTheDocument();
  });

  it("opens with the current title, selected, and keeps the page heading", async () => {
    renderTitle(vi.fn());
    await userEvent.click(pencil());
    expect(field()).toHaveValue("Morning walk");
    expect(field()).toHaveFocus();
    expect(screen.getByRole("heading", { level: 1, name: "Morning walk" })).toBeInTheDocument();
  });

  it("saves the trimmed title with Enter and returns focus to the pencil", async () => {
    const onRename = vi.fn(async () => {});
    renderTitle(onRename);
    await userEvent.click(pencil());
    await userEvent.clear(field());
    await userEvent.type(field(), "  第二期：慢慢听 — Part 2!  {Enter}");
    expect(onRename).toHaveBeenCalledWith("第二期：慢慢听 — Part 2!");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(pencil()).toHaveFocus();
  });

  it("cancels with Escape or Cancel, changing nothing", async () => {
    const onRename = vi.fn(async () => {});
    renderTitle(onRename);
    await userEvent.click(pencil());
    await userEvent.type(field(), " more");
    await userEvent.keyboard("{Escape}");
    expect(pencil()).toHaveFocus();
    await userEvent.click(pencil());
    expect(field()).toHaveValue("Morning walk"); // the abandoned draft is gone
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onRename).not.toHaveBeenCalled();
    expect(pencil()).toHaveFocus();
  });

  it("doesn't save an unchanged title", async () => {
    const onRename = vi.fn(async () => {});
    renderTitle(onRename);
    await userEvent.click(pencil());
    await userEvent.type(field(), "  {Enter}");
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("explains an invalid title in place without saving", async () => {
    const onRename = vi.fn(async () => {});
    renderTitle(onRename);
    await userEvent.click(pencil());
    await userEvent.clear(field());
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Give the episode a title.");
    expect(field()).toHaveAttribute("aria-invalid", "true");
    expect(field()).toHaveAccessibleDescription("Give the episode a title.");
    expect(onRename).not.toHaveBeenCalled();
  });

  it("shows a failed save's safe message and stays open", async () => {
    const onRename = vi.fn(async () => {
      throw new Error("Couldn't rename. Try again.");
    });
    renderTitle(onRename);
    await userEvent.click(pencil());
    await userEvent.type(field(), "!{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't rename. Try again.");
    expect(field()).toHaveValue("Morning walk!");
  });
});
