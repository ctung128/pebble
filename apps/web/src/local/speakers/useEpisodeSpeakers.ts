import { useCallback, useEffect, useRef, useState } from "react";
import type { EpisodeSpeakers, SpeakerCorrectionsRequest } from "@pebble/schema";
import { WorkerError, type WorkerClient } from "../workerClient.ts";

/**
 * Polling while a run is queued or running: quick at first, then every 10 s, at most `maxPolls`
 * times per run (about an hour) before stopping and offering "Check again". Read at each poll, so
 * tests can shorten it.
 */
export const POLLING = {
  delaysMs: [2000, 3000, 5000, 10000] as readonly number[],
  maxPolls: 360,
};
const delayAfter = (polls: number) =>
  POLLING.delaysMs[Math.min(polls, POLLING.delaysMs.length - 1)] ?? 10000;

export type SaveOutcome =
  | { kind: "saved" }
  | { kind: "conflict"; fresh: EpisodeSpeakers | null }
  | { kind: "replaced" }
  | { kind: "failed"; code: string };

export interface EpisodeSpeakersState {
  payload: EpisodeSpeakers | null;
  /** The last request that failed, as a worker error code (never its message). */
  problem: string | null;
  starting: boolean;
  cancelling: boolean;
  saving: boolean;
  pollStopped: boolean;
  start: (speakerCount: number | null) => Promise<void>;
  cancel: () => Promise<void>;
  save: (request: SpeakerCorrectionsRequest) => Promise<SaveOutcome>;
  checkAgain: () => void;
}

const activeRun = (payload: EpisodeSpeakers | null) =>
  payload?.latest && (payload.latest.status === "queued" || payload.latest.status === "running")
    ? payload.latest.runId
    : null;

const codeOf = (error: unknown) => (error instanceof WorkerError ? error.code : "UNKNOWN");

/**
 * One episode's speakers. Reads once when shown, then polls only while the displayed run is queued
 * or running, with bounded requests. Responses for another episode, or arriving after the view
 * changed or unmounted, are ignored. Starting and cancelling ignore repeated clicks.
 */
export function useEpisodeSpeakers(
  client: WorkerClient,
  episodeId: string,
  enabled: boolean,
): EpisodeSpeakersState {
  // Stored with the episode they belong to, so another episode's state is never shown.
  const [stored, setStored] = useState<{ episodeId: string; payload: EpisodeSpeakers } | null>(
    null,
  );
  const [failed, setFailed] = useState<{ episodeId: string; code: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [saving, setSaving] = useState(false);
  // The run whose polling ran out (shown as "Check again"), and a counter to restart polling.
  const [stoppedRun, setStoppedRun] = useState<string | null>(null);
  const [pollRound, setPollRound] = useState(0);
  // Which view a response belongs to: bumped when the episode changes or the view unmounts.
  const view = useRef({ n: 0 }).current;
  const busy = useRef({ start: false, cancel: false, save: false });

  const payload = stored?.episodeId === episodeId ? stored.payload : null;
  const problem = failed?.episodeId === episodeId ? failed.code : null;

  const accept = useCallback(
    (owner: number, next: EpisodeSpeakers) => {
      if (owner !== view.n || next.episodeId !== episodeId) return false;
      setStored({ episodeId, payload: next });
      return true;
    },
    [episodeId, view],
  );

  const report = useCallback(
    (owner: number, error: unknown | null) => {
      if (owner !== view.n) return;
      setFailed(error === null ? null : { episodeId, code: codeOf(error) });
    },
    [episodeId, view],
  );

  /** Reads the episode's speakers; resolves with them if they were accepted for this view. */
  const load = useCallback(
    async (owner: number): Promise<EpisodeSpeakers | null> => {
      try {
        const next = await client.getEpisodeSpeakers(episodeId);
        report(owner, null);
        return accept(owner, next) ? next : null;
      } catch (error) {
        report(owner, error);
        return null;
      }
    },
    [accept, client, episodeId, report],
  );

  // The first read, and a fresh start whenever the episode changes.
  useEffect(() => {
    const owner = ++view.n;
    if (enabled) void load(owner);
    return () => {
      view.n++;
    };
  }, [enabled, episodeId, load, view]);

  // Polling, only while the displayed run is queued or running.
  const runId = activeRun(payload);
  const pollStopped = runId !== null && stoppedRun === runId;
  useEffect(() => {
    if (!enabled || runId === null) return;
    const owner = view.n;
    let polls = 0;
    let timer: number | undefined;
    let alive = true;
    const tick = async () => {
      if (!alive || owner !== view.n) return;
      if (polls >= POLLING.maxPolls) {
        setStoppedRun(runId);
        return;
      }
      polls++;
      await load(owner);
      if (alive) {
        timer = window.setTimeout(() => void tick(), delayAfter(polls));
      }
    };
    timer = window.setTimeout(() => void tick(), delayAfter(0));
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [enabled, load, pollRound, runId, view]);

  const start = useCallback(
    async (speakerCount: number | null) => {
      if (busy.current.start || activeRun(payload) !== null) return;
      busy.current.start = true;
      setStarting(true);
      const owner = view.n;
      try {
        accept(owner, await client.startSpeakerDetection(episodeId, speakerCount));
        report(owner, null);
      } catch (error) {
        report(owner, error);
        if (owner === view.n) await load(owner).then(() => report(owner, error)); // e.g. a run already active: show it
      } finally {
        busy.current.start = false;
        setStarting(false);
      }
    },
    [accept, client, episodeId, load, payload, report, view],
  );

  const cancel = useCallback(async () => {
    const target = activeRun(payload); // exactly the run on screen
    if (target === null || busy.current.cancel) return;
    busy.current.cancel = true;
    setCancelling(true);
    const owner = view.n;
    try {
      accept(owner, await client.cancelSpeakerRun(episodeId, target));
      report(owner, null);
    } catch (error) {
      report(owner, error);
    } finally {
      busy.current.cancel = false;
      setCancelling(false);
    }
  }, [accept, client, episodeId, payload, report, view]);

  const save = useCallback(
    async (request: SpeakerCorrectionsRequest): Promise<SaveOutcome> => {
      if (busy.current.save) return { kind: "failed", code: "BUSY" };
      busy.current.save = true;
      setSaving(true);
      const owner = view.n;
      try {
        accept(owner, await client.saveSpeakerCorrections(request));
        return { kind: "saved" };
      } catch (error) {
        const code = codeOf(error);
        if (code === "SPEAKER_CORRECTIONS_STALE") {
          // Refresh the confirmed state; the caller rebases its draft onto it, never saving.
          return { kind: "conflict", fresh: await load(owner) };
        }
        if (code === "SPEAKER_RUN_MISMATCH" || code === "SPEAKER_RUN_NOT_COMPLETED") {
          await load(owner);
          return { kind: "replaced" };
        }
        return { kind: "failed", code };
      } finally {
        busy.current.save = false;
        setSaving(false);
      }
    },
    [accept, client, load, view],
  );

  const checkAgain = useCallback(() => {
    setStoppedRun(null);
    setPollRound((n) => n + 1);
    void load(view.n);
  }, [load, view]);

  return {
    payload,
    problem,
    starting,
    cancelling,
    saving,
    pollStopped,
    start,
    cancel,
    save,
    checkAgain,
  };
}
