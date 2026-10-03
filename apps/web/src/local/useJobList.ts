import { useCallback, useEffect, useState } from "react";
import type { Job } from "@pebble/schema";
import { isActive } from "./jobCopy.ts";
import type { WorkerClient, WorkerError } from "./workerClient.ts";

export const LIST_POLL_MS = 3000;

/** The worker's job list; refreshes every 3 s while any job is active and the tab is visible. */
export function useJobList(client: WorkerClient, enabled: boolean) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<WorkerError | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: number | undefined;
    client.listJobs().then(
      (next) => {
        if (cancelled) return;
        setJobs(next);
        setError(null);
        if (next.some(isActive) && document.visibilityState !== "hidden") {
          timer = window.setTimeout(() => setTick((n) => n + 1), LIST_POLL_MS);
        }
      },
      (caught: WorkerError) => !cancelled && setError(caught),
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, enabled, tick]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { jobs, error, refresh };
}
