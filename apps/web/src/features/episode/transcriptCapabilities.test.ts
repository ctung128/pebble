import { describe, expect, it } from "vitest";
import { canRequestTranslation, transcriptCapabilities } from "./transcriptCapabilities.ts";

describe("transcriptCapabilities", () => {
  it("gives demo fixtures every tool, including prepared English", () => {
    expect(transcriptCapabilities("fixture")).toEqual({
      learning: true,
      translation: "available",
      copy: true,
    });
  });

  it("gives local ASR transcripts learning tools but no English at all", () => {
    expect(transcriptCapabilities("asr")).toEqual({
      learning: true,
      translation: "hidden",
      copy: true, // Copy Chinese works whatever the translation state
    });
  });

  it("locks everything for mock transcripts", () => {
    expect(transcriptCapabilities("mock")).toEqual({
      learning: false,
      translation: "locked",
      copy: false, // placeholder text: nothing worth copying
    });
  });

  it("only allows translation requests for demo fixtures", () => {
    expect(["fixture", "asr", "mock"].filter((k) => canRequestTranslation(k as never))).toEqual([
      "fixture",
    ]);
  });
});
