import { describe, expect, it, vi } from "vitest";
import { DemoTranslationProvider } from "./DemoTranslationProvider.ts";
import { SessionCachedTranslationProvider, TranslationError } from "./TranslationProvider.ts";

const URL_ = "https://pebble.test/demo/ep-1/translations.en.json";
const table = {
  schemaVersion: "1.0",
  episodeId: "ep-1",
  kind: "prepared-sample",
  language: "en",
  translations: { "seg-1": "Hello." },
};
const request = { episodeId: "ep-1", segmentId: "seg-1", text: "你好。", sourceText: "你好。" };

function provider(fetchImpl = vi.fn(async () => new Response(JSON.stringify(table)))) {
  return {
    fetchImpl,
    provider: new DemoTranslationProvider({ locate: async () => URL_, fetchImpl, delayMs: 0 }),
  };
}

async function errorFrom(promise: Promise<unknown>): Promise<TranslationError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TranslationError);
  return error as TranslationError;
}

describe("DemoTranslationProvider", () => {
  it("returns the prepared translation and loads the table once", async () => {
    const { provider: p, fetchImpl } = provider();
    expect(await p.translate(request)).toEqual({ text: "Hello.", language: "en" });
    await p.translate(request);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not fetch anything until asked", () => {
    const { fetchImpl } = provider();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses edited text without retry", async () => {
    const { provider: p } = provider();
    const error = await errorFrom(p.translate({ ...request, text: "你好呀。" }));
    expect(error.code).toBe("NOT_FOR_EDITED_TEXT");
    expect(error.retryable).toBe(false);
  });

  it("reports fetch failures as retryable and recovers", async () => {
    let fail = true;
    const fetchImpl = vi.fn(async () =>
      fail ? Promise.reject(new TypeError("offline")) : new Response(JSON.stringify(table)),
    );
    const { provider: p } = provider(fetchImpl);
    const error = await errorFrom(p.translate(request));
    expect(error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(error.message).toBe(
      "Translation is unavailable right now. Try again, or keep listening.",
    );
    fail = false;
    expect((await p.translate(request)).text).toBe("Hello.");
  });

  it("reports a missing line as unavailable", async () => {
    const { provider: p } = provider();
    expect((await errorFrom(p.translate({ ...request, segmentId: "seg-9" }))).code).toBe(
      "UNAVAILABLE",
    );
  });

  it("can be forced to fail for development", async () => {
    const p = new DemoTranslationProvider({
      locate: async () => URL_,
      delayMs: 0,
      alwaysFail: true,
    });
    expect((await errorFrom(p.translate(request))).retryable).toBe(true);
  });
});

describe("SessionCachedTranslationProvider", () => {
  it("caches successes for the session and exposes them via peek", async () => {
    const inner = { id: "x", translate: vi.fn(async () => ({ text: "Hi.", language: "en" })) };
    const cached = new SessionCachedTranslationProvider(inner);
    expect(cached.peek(request)).toBeUndefined();
    await Promise.all([cached.translate(request), cached.translate(request)]);
    await cached.translate(request);
    expect(inner.translate).toHaveBeenCalledTimes(1);
    expect(cached.peek(request)?.text).toBe("Hi.");
    expect(cached.peek({ ...request, text: "别的。" })).toBeUndefined();
  });

  it("does not cache failures", async () => {
    const inner = {
      id: "x",
      translate: vi
        .fn()
        .mockRejectedValueOnce(new Error("nope"))
        .mockResolvedValueOnce({ text: "Hi.", language: "en" }),
    };
    const cached = new SessionCachedTranslationProvider(inner);
    await expect(cached.translate(request)).rejects.toThrow("nope");
    expect((await cached.translate(request)).text).toBe("Hi.");
  });
});
