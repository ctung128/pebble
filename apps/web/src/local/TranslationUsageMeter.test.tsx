/** The sidebar's monthly translation meter. Reads worker health only; never translates. */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { parseWorkerHealth, type TranslationHealth } from "@pebble/schema";
import { describe, expect, it, vi } from "vitest";
import { Layout } from "../App.tsx";
import { LearningProvider } from "../features/learning/LearningContext.tsx";
import { MemoryLearningStore } from "../features/learning/MemoryLearningStore.ts";
import { useWorkerTranslation } from "../features/translation/workerTranslation.ts";
import { fakeWorkerClient, funasrHealth } from "../test/localFixtures.tsx";
import { LocalTranslationProvider } from "./LocalTranslationProvider.tsx";
import { requestsLeft, resetDate, TranslationUsageMeter } from "./TranslationUsageMeter.tsx";
import { WorkerError, type WorkerClient } from "./workerClient.ts";
import { WorkerProvider } from "./WorkerContext.tsx";

function translation(
  limits: Partial<TranslationHealth["limits"]> = {},
  overrides: Partial<TranslationHealth> = {},
): TranslationHealth {
  return {
    provider: "deepl",
    configured: true,
    consent: "current",
    consentVersion: "deepl-2026-10",
    newRequests: "available",
    limits: {
      period: "2026-10",
      requestsUsed: 4,
      requestLimit: 50,
      charactersUsed: 48,
      characterLimit: 30000,
      ...limits,
    },
    ...overrides,
  };
}

const reply = (t: TranslationHealth) => parseWorkerHealth({ ...funasrHealth(), translation: t });

/** A stand-in for a line's English button: one explicit request through the provider. */
function TapEnglish() {
  const api = useWorkerTranslation();
  return (
    <button
      type="button"
      onClick={() =>
        void api
          ?.translate({ episodeId: "ep-0123456789ab", segmentId: "s1", text: "你好。" })
          .catch(() => {})
      }
    >
      Tap English
    </button>
  );
}

function renderShell(client: WorkerClient) {
  return render(
    <WorkerProvider client={client}>
      <LocalTranslationProvider>
        <LearningProvider openStore={() => Promise.resolve(new MemoryLearningStore())}>
          <MemoryRouter>
            <Layout mode="local" footer={<TranslationUsageMeter />} />
            <TapEnglish />
          </MemoryRouter>
        </LearningProvider>
      </LocalTranslationProvider>
    </WorkerProvider>,
  );
}

const meter = () => screen.findByRole("meter", { name: "Translations" });

describe("translation usage meter", () => {
  it("shows what's left this month and when it resets, and nothing else", async () => {
    renderShell(fakeWorkerClient({ health: vi.fn(async () => reply(translation())) }));
    const bar = await meter();
    expect(bar).toHaveAttribute("aria-valuenow", "46");
    expect(bar).toHaveAttribute("aria-valuemax", "50");
    expect(bar).toHaveAttribute("aria-valuetext", "46 of 50 translations left this month");
    expect(screen.getByText("46 left")).toBeInTheDocument();
    expect(screen.getByText("of 50 this month")).toBeInTheDocument();
    expect(screen.getByText("Resets Nov 1")).toBeInTheDocument();
    expect(screen.queryByText("Running low")).toBeNull();
    expect(screen.queryByRole("link", { name: /settings/i })).toBeNull();
  });

  it("warns when running low, and says so when none are left", async () => {
    const { unmount } = renderShell(
      fakeWorkerClient({ health: vi.fn(async () => reply(translation({ requestsUsed: 41 }))) }),
    );
    expect(await meter()).toHaveAttribute("aria-valuenow", "9");
    expect(screen.getByText("Running low")).toBeInTheDocument();
    unmount();

    renderShell(
      fakeWorkerClient({
        health: vi.fn(async () =>
          reply(translation({ requestsUsed: 50 }, { newRequests: "local_limit_reached" })),
        ),
      }),
    );
    expect(await meter()).toHaveAttribute("aria-valuenow", "0");
    expect(
      screen.getByText("None left this month. Saved English still shows."),
    ).toBeInTheDocument();
  });

  it("isn't shown when translation isn't set up", async () => {
    renderShell(
      fakeWorkerClient({
        health: vi.fn(async () =>
          reply(
            translation({}, { configured: false, consent: "not_configured", newRequests: "off" }),
          ),
        ),
      }),
    );
    await screen.findByRole("navigation", { name: "Main" });
    await act(async () => {});
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("re-reads usage after a request, including one the provider refused", async () => {
    const health = vi
      .fn()
      .mockResolvedValueOnce(reply(translation()))
      .mockResolvedValue(reply(translation({ requestsUsed: 5, charactersUsed: 51 })));
    const translateLine = vi.fn(async () => {
      throw new WorkerError("TRANSLATION_RATE_LIMITED", "busy", { status: 503 });
    });
    renderShell(fakeWorkerClient({ health, translateLine }));
    expect(await meter()).toHaveAttribute("aria-valuenow", "46");
    await userEvent.click(screen.getByRole("button", { name: "Tap English" }));
    expect(await screen.findByText("45 left")).toBeInTheDocument();
    expect(translateLine).toHaveBeenCalledTimes(1);
  });
});

describe("requestsLeft and resetDate", () => {
  it("counts none left once either limit is spent", () => {
    expect(requestsLeft(translation().limits)).toBe(46);
    expect(requestsLeft(translation({ charactersUsed: 30000 }).limits)).toBe(0);
    expect(requestsLeft(translation({ requestsUsed: 60 }).limits)).toBe(0);
  });

  it("resets on the first of the next UTC month, across the year end", () => {
    expect(resetDate("2026-10")).toBe("Nov 1");
    expect(resetDate("2026-12")).toBe("Jan 1");
  });
});
