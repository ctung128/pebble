import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeWorkerClient, JOB_ID, makeJob } from "../test/localFixtures.tsx";
import { FAST_PHASE_MS, pollDelay, useJobPolling } from "./useJobPolling.ts";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("pollDelay", () => {
  it("polls every second for 30 s, then every 3 s", () => {
    expect(pollDelay(0)).toBe(1000);
    expect(pollDelay(FAST_PHASE_MS - 1)).toBe(1000);
    expect(pollDelay(FAST_PHASE_MS)).toBe(3000);
  });
});

describe("useJobPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  const running = () => makeJob({ status: "running", stage: "probing" });

  it("polls immediately, then on the fast and slow schedules", async () => {
    const getJob = vi.fn(async () => running());
    const client = fakeWorkerClient({ getJob });
    renderHook(() => useJobPolling(client, JOB_ID));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(client.getJob).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(client.getJob).toHaveBeenCalledTimes(6); // every 1 s

    await act(() => vi.advanceTimersByTimeAsync(25_000)); // reaches 30 s
    const atThirty = getJob.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(9000));
    expect(getJob.mock.calls.length - atThirty).toBe(3); // every 3 s
  });

  it("stops at a terminal status", async () => {
    const client = fakeWorkerClient({
      getJob: vi
        .fn()
        .mockResolvedValueOnce(running())
        .mockResolvedValue(makeJob({ status: "completed", stage: "merging" })),
    });
    const { result } = renderHook(() => useJobPolling(client, JOB_ID));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(client.getJob).toHaveBeenCalledTimes(2);
    expect(result.current.job?.status).toBe("completed");
  });

  it("pauses while the tab is hidden and resumes immediately when visible", async () => {
    const client = fakeWorkerClient({ getJob: vi.fn(async () => running()) });
    renderHook(() => useJobPolling(client, JOB_ID));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(client.getJob).toHaveBeenCalledTimes(1);

    act(() => setVisibility("hidden"));
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(client.getJob).toHaveBeenCalledTimes(1);

    act(() => setVisibility("visible"));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(client.getJob).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(client.getJob).toHaveBeenCalledTimes(3);
  });

  it("keeps polling through a temporary worker error", async () => {
    const client = fakeWorkerClient({
      getJob: vi.fn().mockRejectedValueOnce(new Error("blip")).mockResolvedValue(running()),
    });
    const { result } = renderHook(() => useJobPolling(client, JOB_ID));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.error).not.toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(result.current.job?.status).toBe("running");
    expect(result.current.error).toBeNull();
  });

  it("restart() resumes polling after a terminal state", async () => {
    const client = fakeWorkerClient({
      getJob: vi
        .fn()
        .mockResolvedValueOnce(makeJob({ status: "cancelled", failure: cancelled() }))
        .mockResolvedValue(makeJob({ status: "queued", attempt: 2 })),
    });
    const { result } = renderHook(() => useJobPolling(client, JOB_ID));
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(client.getJob).toHaveBeenCalledTimes(1);
    act(() => result.current.restart());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.job?.attempt).toBe(2);
  });
});

function cancelled() {
  return {
    stage: null,
    code: "CANCELLED" as const,
    message: "Cancelled.",
    retryable: true,
    hint: null,
  };
}
