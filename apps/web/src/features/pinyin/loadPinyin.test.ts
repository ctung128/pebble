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

  it("keeps Latin words and numbers whole", async () => {
    const convert = await loadPinyin();
    expect(convert("我用 iPhone 15 拍照，下午3点开会。")).toBe(
      "wǒ yòng iPhone 15 pāi zhào， xià wǔ 3 diǎn kāi huì。",
    );
  });

  it("reuses the loaded module", async () => {
    expect(loadPinyin()).toBe(loadPinyin());
  });
});
