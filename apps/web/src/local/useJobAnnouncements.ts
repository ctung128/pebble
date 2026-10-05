import { useEffect, useRef, useState } from "react";
import type { Job } from "@pebble/schema";
import { modeForJob } from "./providerCopy.ts";

type Phase = "active" | "completed" | "failed" | "cancelled";

const phase = (job: Job): Phase =>
  job.status === "queued" || job.status === "running" ? "active" : job.status;

function announcement(job: Job): string {
  switch (phase(job)) {
    case "active":
      return `${job.episodeTitle}: processing started.`;
    case "completed":
      return `${job.episodeTitle}: ${modeForJob(job) === "funasr" ? "transcript" : "preview"} ready.`;
    case "failed":
      return `${job.episodeTitle}: couldn't be processed.`;
    case "cancelled":
      return `${job.episodeTitle}: cancelled.`;
  }
}

/**
 * A message for a polite live region when a job changes phase (started, ready, failed,
 * cancelled). Section ticks and repeated polls of the same phase say nothing, and the first
 * load is never announced.
 */
export function useJobAnnouncements(jobs: readonly Job[] | null): string {
  const seen = useRef<Map<string, Phase> | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!jobs) return;
    const previous = seen.current;
    const next = new Map(jobs.map((job) => [job.id, phase(job)]));
    seen.current = next;
    if (!previous) return; // the first list is what's already there, not news
    const changed = jobs.filter((job) => previous.get(job.id) !== phase(job));
    if (changed.length > 0) setMessage(changed.map(announcement).join(" "));
  }, [jobs]);

  return message;
}
