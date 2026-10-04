/**
 * WCAG contrast for the documented token pairs, in both themes, read from the real tokens.css.
 * Text pairs need 4.5:1; control outlines, focus rings and non-text fills need 3:1.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Read the file directly: Vitest turns CSS imports (even ?raw) into empty strings.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "tokens.css"), "utf8");

function declarations(block: string): Map<string, string> {
  return new Map([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

const lightBlock = /:root \{\s*color-scheme: light dark;([\s\S]*?)\n\}/.exec(css)?.[1];
const darkBlock = /prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\}/.exec(css)?.[1];
if (!lightBlock || !darkBlock) throw new Error("tokens.css: light or dark block not found");

const light = declarations(lightBlock);
const themes = {
  light,
  dark: new Map([...light, ...declarations(darkBlock)]), // dark overrides the semantic names
};

function resolve(theme: Map<string, string>, name: string): string {
  let value = theme.get(name);
  for (let depth = 0; value?.startsWith("var(--") && depth < 10; depth++) {
    value = theme.get(value.slice(6, -1));
  }
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`--${name} isn't a hex colour`);
  return value;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const TEXT = 4.5;
const UI = 3;
const PAIRS: [foreground: string, background: string, minimum: number][] = [
  ["text-primary", "bg-page", TEXT],
  ["text-primary", "bg-subtle", TEXT],
  ["text-primary", "bg-selected", TEXT],
  ["text-secondary", "bg-page", TEXT],
  ["text-secondary", "bg-subtle", TEXT],
  ["text-tertiary", "bg-page", TEXT],
  ["text-tertiary", "bg-subtle", TEXT],
  ["text-tertiary", "bg-muted", TEXT],
  ["text-accent", "bg-page", TEXT],
  ["text-accent", "bg-selected", TEXT],
  ["text-on-accent", "accent", TEXT],
  ["error", "bg-page", TEXT],
  ["error", "error-bg", TEXT],
  ["warning", "warning-bg", TEXT],
  ["border-control", "bg-page", UI],
  ["border-control", "bg-subtle", UI],
  ["focus-ring", "bg-page", UI],
  ["focus-ring", "bg-subtle", UI],
  ["accent-pending", "bg-page", UI], // non-text fills only
];

describe.each(Object.entries(themes))("%s theme contrast", (_, theme) => {
  it.each(PAIRS)("--%s on --%s is at least %s:1", (foreground, background, minimum) => {
    expect(contrast(resolve(theme, foreground), resolve(theme, background))).toBeGreaterThanOrEqual(
      minimum,
    );
  });
});

describe("contrast helper", () => {
  it("matches the WCAG reference values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
});
