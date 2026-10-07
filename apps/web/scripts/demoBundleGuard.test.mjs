import { describe, expect, it } from "vitest";
import { findDemoBundleLeaks } from "./demoBundleGuard.mjs";

// What the shared schema compiles to in the demo bundle (minified, as Vite emits it).
const SCHEMA_CHUNK =
  "var tm=z.string().min(1),rm=`deepl`,im=`EN-US`,am=2e3,om=[[13312,19903],[19968,40959]];";

const check = (...texts) =>
  findDemoBundleLeaks(texts.map((text, i) => ({ name: `chunk-${i}.js`, text })));

describe("demo bundle guard", () => {
  it("accepts the shared schema's provider identifier and nothing else", () => {
    expect(check(SCHEMA_CHUNK, "export const x = 1;")).toEqual([]);
    expect(check(SCHEMA_CHUNK.replace("`deepl`", '"deepl"'))).toEqual([]);
  });

  it.each([
    ["the brand", "Translated by DeepL (deepl.com)"],
    ["the attribution link", 'href:"https://www.deepl.com"'],
    ["a consent version", '"deepl-2026-10"'],
    ["the provider name in other copy", "Translate with DeepL?"],
    ["the consent route", '"translation/consent"'],
    ["the translation route", "`/translations`"],
    ["consent dialog copy", "Pebble couldn't record your choice."],
    ["the earlier-version label", "English for an earlier version of this line"],
    ["Show saved English", "Show saved English"],
    ["settings copy", "English translation with DeepL: allowed for this computer"],
    ["Withdraw", "Withdraw"],
    ["the key variable", "DEEPL_AUTH_KEY"],
  ])("fails on %s", (_, forbidden) => {
    expect(check(`var a=1;${forbidden};`).length).toBeGreaterThan(0);
  });

  it("doesn't skip a chunk because it also holds the schema code", () => {
    const leaks = check(`${SCHEMA_CHUNK}var c="Translate with DeepL?";`);
    expect(leaks.join("\n")).toMatch(/Translate with/);
    expect(leaks.join("\n")).toMatch(/provider name outside the schema identifier/);
  });

  it("fails when an unrelated literal replaces the schema occurrence", () => {
    const withoutSchema = SCHEMA_CHUNK.replace("`deepl`", "`other`");
    expect(check(withoutSchema, "var p=`deepl`;").length).toBeGreaterThan(0);
    expect(check(`${withoutSchema}var p="deepl";`).length).toBeGreaterThan(0);
  });

  it("fails on a provider literal outside the schema's compiled context", () => {
    expect(check("var rm=`deepl`,im=`EN-GB`,am=2e3,om=[[13312,19903]];").length).toBeGreaterThan(0);
    expect(check("var rm=`deepl`;var im=`EN-US`;").length).toBeGreaterThan(0);
  });

  it("fails on a second provider literal, anywhere", () => {
    expect(check(SCHEMA_CHUNK, "var x=`deepl`;").join("\n")).toMatch(/outside the schema/);
    expect(check(SCHEMA_CHUNK, SCHEMA_CHUNK).join("\n")).toMatch(/2 provider identifiers/);
  });

  it("still catches the existing local-mode markers", () => {
    expect(check("fetch(`http://127.0.0.1:8790/health`)").length).toBeGreaterThan(0);
    expect(check("FunASR Paraformer").length).toBeGreaterThan(0);
  });
});
