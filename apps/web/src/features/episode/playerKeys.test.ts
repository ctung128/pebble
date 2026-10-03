import { describe, expect, it } from "vitest";
import { resolvePlayerKey } from "./playerKeys.ts";

const press = (key: string, target: EventTarget | null = document.body, mods = {}) =>
  resolvePlayerKey({ key, target, metaKey: false, ctrlKey: false, altKey: false, ...mods });

const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
) => {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
};

describe("resolvePlayerKey", () => {
  it("maps the documented keys", () => {
    expect(press(" ")).toBe("toggle");
    expect(press("r")).toBe("replay");
    expect(press("R")).toBe("replay");
    expect(press("ArrowLeft")).toBe("previous");
    expect(press("ArrowRight")).toBe("next");
    expect(press("x")).toBeNull();
  });

  it("handles Space on a focused button", () => {
    expect(press(" ", element("button"))).toBe("toggle");
  });

  it("ignores keys with modifiers", () => {
    expect(press("r", document.body, { metaKey: true })).toBeNull();
    expect(press("ArrowRight", document.body, { altKey: true })).toBeNull();
  });

  it("ignores text entry", () => {
    expect(press("r", element("input", { type: "text" }))).toBeNull();
    expect(press(" ", element("textarea"))).toBeNull();
    expect(press("ArrowLeft", element("select"))).toBeNull();
  });

  it("leaves arrows to the seek slider but keeps Space", () => {
    const slider = element("input", { type: "range" });
    expect(press("ArrowRight", slider)).toBeNull();
    expect(press(" ", slider)).toBe("toggle");
  });
});
