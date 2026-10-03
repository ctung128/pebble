import { describe, expect, it } from "vitest";
import { formatPinyin, loadPinyin } from "./loadPinyin.ts";

describe("pinyin", () => {
  it("attaches punctuation to the preceding syllable", () => {
    expect(formatPinyin("nǐ hǎo ， shì jiè 。")).toBe("nǐ hǎo， shì jiè。");
  });

  it("generates tone-marked pinyin", async () => {
    const convert = await loadPinyin();
    expect(convert("你好，欢迎。")).toBe("nǐ hǎo， huān yíng。");
  });

  it("reuses the loaded module", async () => {
    expect(loadPinyin()).toBe(loadPinyin());
  });
});
