import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuideTip, SETTLE_MS, hasSeenTip, resetGuideTipsForTests } from "./GuideTip.tsx";

const MESSAGE =
  "Tip: With the Zhongwen browser extension turned on, hover any character to see its pinyin and meaning.";
const COUNT = 20; // lines; 25% is reached at the 5th line (index 4)

const list = document.createElement("ol");
const anchor = createRef<HTMLElement>() as { current: HTMLElement | null };

function tip(index: number, extra: { userScrolled?: boolean } = {}) {
  return (
    <GuideTip
      id="zhongwen-hover"
      trigger={{ type: "episode-progress", at: 0.25 }}
      message={MESSAGE}
      action={{ label: "Get Zhongwen", href: "https://example.test/zhongwen" }}
      progress={{ index, count: COUNT }}
      anchor={anchor}
      userScrolled={extra.userScrolled ?? false}
      requiresHover
    />
  );
}

/** Lets the tip's settle-then-measure delay (and any timers) run. */
async function tick(ms = SETTLE_MS + 20) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

const bubble = () => screen.queryByRole("status");

function stubMedia(matching: string[]) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: matching.includes(query) }));
}

beforeEach(() => {
  vi.useFakeTimers();
  resetGuideTipsForTests();
  window.sessionStorage.clear();
  anchor.current = list;
  stubMedia(["(hover: hover) and (pointer: fine)"]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GuideTip", () => {
  it("shows once the current line passes 25% of the lines, as a polite status", async () => {
    const { rerender } = render(tip(2));
    await tick();
    expect(bubble()).toBeNull();
    rerender(tip(4));
    await tick();
    expect(bubble()).toHaveTextContent(MESSAGE.slice("Tip: ".length));
    expect(screen.getByText("Tip:")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Get Zhongwen" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    // The character is decorative; the bubble carries the meaning.
    expect(document.querySelector("img")).toHaveAttribute("alt", "");
    expect(document.querySelector("img")).toHaveAttribute("aria-hidden", "true");
    // Never takes focus.
    expect(document.activeElement).toBe(document.body);
    expect(hasSeenTip("zhongwen-hover")).toBe(true);
  });

  it("doesn't show again after scrolling back, or on another visit this session", async () => {
    const { rerender, unmount } = render(tip(4));
    await tick();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss tip" }));
    await tick(200);
    expect(bubble()).toBeNull();
    rerender(tip(1));
    await tick();
    rerender(tip(6));
    await tick();
    expect(bubble()).toBeNull();
    unmount();

    render(tip(8));
    await tick();
    expect(bubble()).toBeNull();
  });

  it("dismisses straight away from its button", async () => {
    render(tip(4));
    await tick();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss tip" }));
    await tick(200);
    expect(bubble()).toBeNull();
  });

  it("stays until the learner dismisses it, however far they go", async () => {
    const { rerender } = render(tip(4));
    await tick();
    rerender(tip(COUNT - 1));
    await tick(60_000);
    expect(bubble()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss tip" }));
    await tick(200);
    expect(bubble()).toBeNull();
  });

  it("counts the learner's scrolling, never Pebble's own follow-scroll", async () => {
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue({
      top: -400,
      height: 1000,
      right: 0,
    } as DOMRect);
    const { rerender } = render(tip(0, { userScrolled: false }));
    fireEvent.scroll(window);
    await tick();
    expect(bubble()).toBeNull();
    rerender(tip(0, { userScrolled: true }));
    fireEvent.scroll(window);
    await tick();
    expect(bubble()).not.toBeNull();
  });

  it("works when sessionStorage is blocked", async () => {
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const { unmount } = render(tip(4));
    await tick();
    expect(bubble()).not.toBeNull();
    unmount();
    render(tip(6));
    await tick();
    expect(bubble()).toBeNull(); // remembered in memory instead
  });

  it("has no motion under reduced motion, and leaves without a fade", async () => {
    stubMedia(["(hover: hover) and (pointer: fine)", "(prefers-reduced-motion: reduce)"]);
    render(tip(4));
    await tick();
    expect(bubble()?.closest("[data-phase]")).toHaveAttribute("data-reduced-motion", "true");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss tip" }));
    await tick(1);
    expect(bubble()).toBeNull();
  });

  it("isn't shown on touch devices, where there's nothing to hover", async () => {
    stubMedia([]);
    render(tip(10));
    await tick();
    expect(bubble()).toBeNull();
    expect(hasSeenTip("zhongwen-hover")).toBe(false);
  });
});
