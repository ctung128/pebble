import { useEffect, useRef, useState } from "react";
import type { Job } from "@pebble/schema";
import type { SectionChange } from "./jobProgress.ts";

/** The current time, updated every second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * Section completions this page saw happen, timed when they were first seen. The count the
 * page opens on isn't one (that section may have finished long ago). A new attempt starts over.
 */
export function useSectionChanges(job: Job | null): SectionChange[] {
  const seen = useRef<{ attempt: number; n: number } | null>(null);
  const [changes, setChanges] = useState<SectionChange[]>([]);
  const attempt = job?.attempt ?? null;
  const completed = job?.progress?.completedChunks ?? null;

  useEffect(() => {
    if (attempt === null) return;
    const previous = seen.current;
    if (previous && previous.attempt !== attempt) setChanges([]);
    if (completed === null) {
      seen.current = { attempt, n: -1 };
      return;
    }
    if (previous && previous.attempt === attempt && completed > previous.n && previous.n >= 0) {
      const at = Date.now();
      setChanges((list) => [...list, { n: completed, at }]);
    }
    seen.current = { attempt, n: completed };
  }, [attempt, completed]);

  return changes;
}

/** Shortest gap between "N of M sections done" announcements. */
export const SECTION_ANNOUNCE_MS = 30_000;

/**
 * What the page's polite live region says: the headline when the status or stage changes, and
 * section progress at most every 30 s. The first load and repeated polls say nothing, so a
 * screen reader isn't read every section tick.
 */
export function useProgressAnnouncement(job: Job | null, headline: string): string {
  const last = useRef<{ key: string; at: number } | null>(null);
  const [message, setMessage] = useState("");
  const key = job ? `${job.attempt}:${job.status}:${job.stage ?? ""}` : null;
  const completed = job?.progress?.completedChunks ?? null;
  const total = job?.progress?.totalChunks ?? null;

  useEffect(() => {
    if (key === null) return;
    const now = Date.now();
    const previous = last.current;
    if (!previous) {
      last.current = { key, at: now };
      return;
    }
    if (previous.key !== key) {
      last.current = { key, at: now };
      setMessage(headline);
      return;
    }
    if (completed !== null && total !== null && now - previous.at >= SECTION_ANNOUNCE_MS) {
      last.current = { key, at: now };
      setMessage(`${completed} of ${total} sections done`);
    }
    // The headline changes with every section; only the key and the count drive announcing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, completed, total]);

  return message;
}
