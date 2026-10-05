import { describe, expect, it } from "vitest";
import { foldForSearch, matchesQuery } from "./search.ts";

describe("matchesQuery", () => {
  it.each([
    ["Morning walk", "walk", true],
    ["Morning walk", "MORNING", true],
    ["Morning walk", "ＭＯＲＮＩＮＧ", true], // full-width folds with NFKC
    ["第二期：慢慢听", "慢慢", true],
    ["第二期：慢慢听", "第二期:", true], // full-width colon matches its ASCII form
    ["S1E2 慢慢听 | Slow listening", "slow list", true],
    ["Morning walk", "  walk  ", true],
    ["Morning walk", "", true],
    ["Morning walk", "run", false],
    ["慢慢听", "快", false],
  ])("%j contains %j → %s", (text, query, expected) => {
    expect(matchesQuery(text, query)).toBe(expected);
  });
});

describe("foldForSearch", () => {
  it("drops tone marks and accents, leaving Chinese alone", () => {
    expect(foldForSearch("tiān qì hěn hǎo")).toBe("tian qi hen hao");
    expect(foldForSearch("Café")).toBe("cafe");
    expect(foldForSearch("天气很好")).toBe("天气很好");
    expect(matchesQuery("jīn tiān", "jin tian", foldForSearch)).toBe(true);
  });
});
