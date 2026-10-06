import { useCallback, useEffect, useState } from "react";
import type { Job } from "@pebble/schema";
import { TERMINAL_STATUSES } from "./jobCopy.ts";
import type { WorkerClient, WorkerError } from "./workerClient.ts";

export const FAST_POLL_MS = 1000;
export const SLOW_POLL_MS = 3000;
/** Poll every second for the first 30 s of watching, then every 3 s. */
export const FAST_PHASE_MS = 30_000;
/** In a background tab: slow, but enough to keep the tab title's progress current. */
export const HIDDEN_POLL_MS = 10_000;

export function pollDelay(elapsedMs: number): number {
  return elapsedMs < FAST_PHASE_MS ? FAST_POLL_MS : SLOW_POLL_MS;
}

const isHidden = () => document.visibilityState === "hidden";

/**
 * Polls a job until it reaches a terminal status. Slows to every 10 s while the tab is hidden
 * (the tab title shows progress) and polls immediately when it becomes visible again.
 * `restart()` (after cancel/retry) resets the fast phase.
 */
export function useJobPolling(client: WorkerClient, jobId: string) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<WorkerError | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let timer: number | undefined;
    const startedAt = Date.now();

    const schedule = () => {
      if (stopped) return;
      const delay = isHidden() ? HIDDEN_POLL_MS : pollDelay(Date.now() - startedAt);
      timer = window.setTimeout(poll, delay);
    };

    async function poll() {
      timer = undefined;
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const next = await client.getJob(jobId);
        if (stopped) return;
        setJob(next);
        setError(null);
        if (TERMINAL_STATUSES.has(next.status)) {
          stopped = true;
          return;
        }
      } catch (caught) {
        if (stopped) return;
        setError(caught as WorkerError);
      } finally {
        inFlight = false;
      }
      schedule();
    }

    const onVisibility = () => {
      if (stopped || inFlight) return;
      window.clearTimeout(timer);
      timer = undefined;
      // Back in view: check now. Hidden: the next poll comes at the slower pace.
      if (isHidden()) schedule();
      else void poll();
    };

    document.addEventListener("visibilitychange", onVisibility);
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [client, jobId, generation]);

  const restart = useCallback(() => setGeneration((n) => n + 1), []);
  return { job, error, restart };
}
