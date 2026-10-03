import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// jsdom implements neither media playback nor scrolling.
Object.defineProperty(HTMLMediaElement.prototype, "play", {
  configurable: true,
  value: vi.fn(() => Promise.resolve()),
});
Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: vi.fn() });
Object.defineProperty(HTMLMediaElement.prototype, "load", { configurable: true, value: vi.fn() });
Element.prototype.scrollIntoView = vi.fn();
