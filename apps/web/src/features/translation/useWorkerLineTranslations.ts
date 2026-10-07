import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Segment } from "@pebble/schema";
import type { LineTranslation } from "./useLineTranslations.ts";
import {
  canRetry,
  canSend,
  fingerprintOf,
  submittedText,
  type CachedEnglish,
  type WorkerTranslation,
  WorkerTranslationError,
} from "./workerTranslation.ts";

type RequestState =
  | { fingerprint: string; status: "loading" }
  | { fingerprint: string; status: "error"; code: string };

/** Everything that belongs to one episode view; state for another episode is never read. */
interface EpisodeState {
  episodeId: string;
  cache: ReadonlyMap<string, readonly CachedEnglish[]>;
  open: ReadonlySet<string>;
  requests: ReadonlyMap<string, RequestState>;
  showSaved: boolean;
}

const emptyState = (episodeId: string): EpisodeState => ({
  episodeId,
  cache: new Map(),
  open: new Set(),
  requests: new Map(),
  showSaved: false,
});

/**
 * Per-line English from the local worker (ADR 0008). What a line shows is derived from cache
 * identity: episode, segment and the fingerprint of the exact text it would send. So an edited
 * line never shows its old English as current, a revert finds its earlier translation again,
 * and a late answer only ever describes the text (and episode) it was asked for.
 *
 * Nothing is sent on render, load, edit, navigation, "Show saved English", consent or recovery:
 * only `toggle` and `retry` (an explicit tap, or the T key) can submit, one line each.
 */
export function useWorkerLineTranslations(
  api: WorkerTranslation | null,
  episodeId: string,
  /** Each line's displayed Chinese (the learner's correction where there is one). */
  displayed: ReadonlyMap<string, string>,
) {
  const [stored, setStored] = useState<EpisodeState>(() => emptyState(episodeId));
  const [fingerprints, setFingerprints] = useState<ReadonlyMap<string, string>>(new Map());
  // Another episode starts clean: anything kept for the previous one is ignored.
  const empty = useMemo(() => emptyState(episodeId), [episodeId]);
  const state = stored.episodeId === episodeId ? stored : empty;

  const mounted = useRef(true);
  const latest = useRef({ api, episodeId, displayed, fingerprints });
  useLayoutEffect(() => {
    latest.current = { api, episodeId, displayed, fingerprints };
  });
  const inFlight = useRef(new Set<string>());
  const enabled = api !== null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Updates one episode's state; a late update for another episode is dropped. */
  const update = useCallback(
    (forEpisode: string, change: (state: EpisodeState) => EpisodeState) => {
      if (!mounted.current || latest.current.episodeId !== forEpisode) return;
      setStored((previous) =>
        change(previous.episodeId === forEpisode ? previous : emptyState(forEpisode)),
      );
    },
    [],
  );

  // Cached English for this episode: read-only, and never a reason to send anything.
  useEffect(() => {
    if (!enabled) return;
    const forEpisode = episodeId;
    let cancelled = false;
    latest.current.api
      ?.loadCached(forEpisode)
      .then((rows) => {
        if (cancelled) return;
        update(forEpisode, (s) => {
          const cache = new Map(s.cache);
          for (const row of rows) addRow(cache, row);
          return { ...s, cache };
        });
      })
      .catch(() => {
        // No cached English to show; taps still work. Nothing is logged.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, episodeId, update]);

  // Fingerprints of the texts lines would send (computed locally; nothing leaves the page).
  useEffect(() => {
    if (!enabled) return;
    const missing = [...new Set([...displayed.values()].map(submittedText))].filter(
      (text) => !fingerprints.has(text),
    );
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(missing.map(async (text) => [text, await fingerprintOf(text)] as const)).then(
      (pairs) => {
        if (cancelled || !mounted.current) return;
        setFingerprints((existing) => {
          const next = new Map(existing);
          for (const [text, fp] of pairs) next.set(text, fp);
          return next;
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, displayed, fingerprints]);

  const setRequest = useCallback(
    (forEpisode: string, segmentId: string, request: RequestState | null) =>
      update(forEpisode, (s) => {
        const requests = new Map(s.requests);
        if (request) requests.set(segmentId, request);
        else requests.delete(segmentId);
        return { ...s, requests };
      }),
    [update],
  );

  const setOpen = useCallback(
    (forEpisode: string, segmentId: string, isOpen: boolean) =>
      update(forEpisode, (s) => {
        const open = new Set(s.open);
        if (isOpen) open.add(segmentId);
        else open.delete(segmentId);
        return { ...s, open };
      }),
    [update],
  );

  /** The one path that may send a line, always from an explicit learner action. */
  const attempt = useCallback(
    async (segment: Segment) => {
      const { api: service, episodeId: forEpisode, displayed: shown } = latest.current;
      if (!service) return;
      const text = submittedText(shown.get(segment.id) ?? segment.text);
      const fingerprint = latest.current.fingerprints.get(text) ?? (await fingerprintOf(text));
      const key = `${forEpisode}\u0000${segment.id}\u0000${fingerprint}`;
      if (inFlight.current.has(key)) return; // a repeated click while this one is pending
      const stillTheSameLine = () =>
        mounted.current &&
        latest.current.episodeId === forEpisode &&
        submittedText(latest.current.displayed.get(segment.id) ?? segment.text) === text;

      if (!canSend(text)) {
        setRequest(forEpisode, segment.id, {
          fingerprint,
          status: "error",
          code: "TRANSLATION_INVALID_TEXT",
        });
        return;
      }
      const readiness = service.readiness.newRequests;
      if (readiness === "off" || readiness === "local_limit_reached") {
        const code = readiness === "off" ? "TRANSLATION_OFF" : "TRANSLATION_LOCAL_LIMIT";
        setRequest(forEpisode, segment.id, { fingerprint, status: "error", code });
        return;
      }
      inFlight.current.add(key);
      try {
        if (readiness === "consent_required") {
          // Confirming the dialog is this tap's request; cancelling sends nothing.
          const outcome = await service.requestConsent();
          if (outcome !== "granted") {
            setRequest(forEpisode, segment.id, null);
            setOpen(forEpisode, segment.id, false);
            return;
          }
          if (!stillTheSameLine()) return; // the line changed meanwhile: nothing is sent
        }
        setRequest(forEpisode, segment.id, { fingerprint, status: "loading" });
        const english = await service.translate({
          episodeId: forEpisode,
          segmentId: segment.id,
          text,
        });
        if (english.fingerprint !== fingerprint || english.segmentId !== segment.id) {
          setRequest(forEpisode, segment.id, {
            fingerprint,
            status: "error",
            code: "TRANSLATION_UNAVAILABLE",
          });
          return;
        }
        update(forEpisode, (s) => {
          const cache = new Map(s.cache);
          addRow(cache, english);
          const requests = new Map(s.requests);
          if (requests.get(segment.id)?.fingerprint === fingerprint) requests.delete(segment.id);
          return { ...s, cache, requests };
        });
      } catch (error) {
        const code =
          error instanceof WorkerTranslationError ? error.code : "TRANSLATION_UNAVAILABLE";
        setRequest(forEpisode, segment.id, { fingerprint, status: "error", code });
      } finally {
        inFlight.current.delete(key);
      }
    },
    [setOpen, setRequest, update],
  );

  const lines = useMemo(() => {
    const map = new Map<string, LineTranslation>();
    if (!api) return map;
    for (const [segmentId, shownText] of displayed) {
      const fingerprint = fingerprints.get(submittedText(shownText));
      const rows = state.cache.get(segmentId) ?? [];
      const match = fingerprint ? rows.find((row) => row.fingerprint === fingerprint) : undefined;
      const newest = rows[rows.length - 1];
      const request = state.requests.get(segmentId);
      const forThisText = request && request.fingerprint === fingerprint ? request : undefined;
      const isOpen = state.open.has(segmentId) || (state.showSaved && match !== undefined);
      if (!isOpen) continue;
      const base = { open: true, forText: shownText } as const;
      if (forThisText?.status === "loading") {
        map.set(segmentId, { ...base, status: "loading" });
      } else if (forThisText?.status === "error") {
        map.set(segmentId, {
          ...base,
          status: "error",
          message: api.message(forThisText.code),
          retryable: canRetry(forThisText.code),
        });
      } else if (match) {
        map.set(segmentId, {
          ...base,
          status: "ready",
          text: match.text,
          attribution: api.attribution,
        });
      } else if (newest) {
        map.set(segmentId, {
          ...base,
          status: "ready",
          text: newest.text,
          stale: { label: api.labels.stale, action: api.labels.translateAgain },
          attribution: api.attribution,
        });
      } else if (!fingerprint) {
        map.set(segmentId, { ...base, status: "loading" });
      }
    }
    return map;
  }, [api, displayed, fingerprints, state]);

  const { open, cache, showSaved } = state;

  /** Opens or closes a line's English. Sends only if the line has no cached English at all. */
  const toggle = useCallback(
    (segment: Segment) => {
      const forEpisode = latest.current.episodeId;
      if (open.has(segment.id)) {
        setOpen(forEpisode, segment.id, false);
        return;
      }
      setOpen(forEpisode, segment.id, true);
      // Cached English for this line (current, or an earlier version shown as such) needs no
      // request; "Translate again" is a separate, explicit action.
      if ((cache.get(segment.id)?.length ?? 0) > 0) return;
      void attempt(segment);
    },
    [attempt, cache, open, setOpen],
  );

  /** "Try again" or "Translate again": an explicit request for the line's current text. */
  const retry = useCallback(
    (segment: Segment) => {
      setOpen(latest.current.episodeId, segment.id, true);
      void attempt(segment);
    },
    [attempt, setOpen],
  );

  const setShowSaved = useCallback(
    (value: boolean) => update(latest.current.episodeId, (s) => ({ ...s, showSaved: value })),
    [update],
  );

  /**
   * English to save with a learning item: only cached English whose fingerprint matches the
   * line's exact submitted (NFC) text right now. An earlier version, a pending or failed
   * request, or a fingerprint not yet computed means none. Never sends anything.
   */
  const currentEnglish = useCallback(
    (segmentId: string): string | null => {
      const shown = latest.current.displayed.get(segmentId);
      if (shown === undefined) return null;
      const fingerprint = latest.current.fingerprints.get(submittedText(shown));
      if (!fingerprint) return null;
      return cache.get(segmentId)?.find((row) => row.fingerprint === fingerprint)?.text ?? null;
    },
    [cache],
  );

  /** Whether this line has any cached English (current or earlier). */
  const hasCached = useCallback(
    (segmentId: string) => (cache.get(segmentId)?.length ?? 0) > 0,
    [cache],
  );

  // Stable between state changes, so memoized rows don't re-render on every playback frame.
  return useMemo(
    () => ({ lines, toggle, retry, showSaved, setShowSaved, hasCached, currentEnglish }),
    [lines, toggle, retry, showSaved, setShowSaved, hasCached, currentEnglish],
  );
}

function addRow(map: Map<string, readonly CachedEnglish[]>, row: CachedEnglish) {
  const rows = map.get(row.segmentId) ?? [];
  if (rows.some((existing) => existing.fingerprint === row.fingerprint)) return;
  // Oldest first (stable for equal times), so the last row is the newest earlier version.
  map.set(
    row.segmentId,
    [...rows, row].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  );
}
