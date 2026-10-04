import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { WorkerClient } from "./workerClient.ts";
import type { LocalMode } from "./providerCopy.ts";
import { checkWorker, statusMode, type WorkerStatus } from "./workerHealth.ts";

/** How often to re-check while the worker isn't ready (e.g. waiting for `npm run worker`). */
export const HEALTH_RETRY_MS = 5000;
/** Faster re-checks while the worker is verifying its speech models (a few seconds). */
export const CHECKING_RETRY_MS = 1000;

interface WorkerContextValue {
  client: WorkerClient;
  status: WorkerStatus;
  /** The worker's provider mode as last reported (kept while re-checking); null if unknown. */
  mode: LocalMode | null;
  recheck: () => void;
}

const WorkerContext = createContext<WorkerContextValue | null>(null);

export function WorkerProvider({
  client,
  children,
}: {
  client: WorkerClient;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<WorkerStatus>({ kind: "checking" });
  const [mode, setMode] = useState<LocalMode | null>(null);
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void checkWorker(client).then((next) => {
      if (cancelled) return;
      setStatus(next);
      const nextMode = statusMode(next);
      if (nextMode) setMode(nextMode);
      if (next.kind !== "ready") {
        const delay = next.kind === "provider-checking" ? CHECKING_RETRY_MS : HEALTH_RETRY_MS;
        timer.current = window.setTimeout(() => setAttempt((n) => n + 1), delay);
      }
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer.current);
    };
  }, [client, attempt]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setAttempt((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const recheck = useCallback(() => {
    setStatus({ kind: "checking" });
    setAttempt((n) => n + 1);
  }, []);

  return (
    <WorkerContext.Provider value={{ client, status, mode, recheck }}>
      {children}
    </WorkerContext.Provider>
  );
}

export function useWorker(): WorkerContextValue {
  const value = useContext(WorkerContext);
  if (!value) throw new Error("useWorker must be used inside <WorkerProvider>.");
  return value;
}
