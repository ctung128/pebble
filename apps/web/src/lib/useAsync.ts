import { useCallback, useEffect, useState } from "react";

export type AsyncState<T> =
  { status: "loading" } | { status: "success"; data: T } | { status: "error"; error: unknown };

/**
 * Runs `load` on mount and whenever it changes identity (memoize it with useCallback).
 * Late results from a superseded load are ignored.
 */
export function useAsync<T>(load: () => Promise<T>): AsyncState<T> & { retry: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (data) => !cancelled && setState({ status: "success", data }),
      (error: unknown) => !cancelled && setState({ status: "error", error }),
    );
    return () => {
      cancelled = true;
    };
  }, [load, attempt]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  return { ...state, retry };
}
