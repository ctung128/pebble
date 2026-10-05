import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CURRENT_SCHEMA_VERSION,
  type Correction,
  type LearningItem,
  type Segment,
} from "@pebble/schema";
import { correctionKey, type LearningStore } from "./LearningStore.ts";
import type { PlaybackRecord } from "./playback.ts";

export type Persistence =
  | { mode: "loading" }
  | { mode: "persistent" }
  | { mode: "session"; reason: "unavailable" | "write-failed" };

export type CorrectionResult = "saved" | "reverted" | "unchanged" | "empty";

interface LearningContextValue {
  persistence: Persistence;
  corrections: ReadonlyMap<string, Correction>;
  items: readonly LearningItem[];
  correctionFor: (episodeId: string, segmentId: string) => Correction | null;
  itemForSegment: (episodeId: string, segmentId: string) => LearningItem | null;
  saveCorrection: (episodeId: string, segment: Segment, text: string) => CorrectionResult;
  revertCorrection: (episodeId: string, segmentId: string) => void;
  saveItem: (item: LearningItem) => void;
  removeItem: (id: string) => void;
  updateNote: (id: string, note: string) => void;
  /**
   * After a local episode is deleted: removes its corrections and marks its saved learning
   * items "source deleted". The items themselves are kept.
   */
  markSourceDeleted: (episodeId: string) => void;
  resetAll: () => void;
  /** Listening progress per episode (browser-local; see playback.ts). */
  playback: ReadonlyMap<string, PlaybackRecord>;
  playbackFor: (episodeId: string) => PlaybackRecord | null;
  savePlayback: (record: PlaybackRecord) => void;
  clearPlayback: (episodeId: string) => void;
}

const LearningContext = createContext<LearningContextValue | null>(null);

/**
 * Owns learner data in React state (the source of truth for the UI) and writes it through
 * to the store. If storage can't be opened, or a write fails, everything keeps working for
 * the session and the persistence state says so.
 */
export function LearningProvider({
  openStore,
  children,
}: {
  openStore: () => Promise<LearningStore>;
  children: ReactNode;
}) {
  const storeRef = useRef<LearningStore | null>(null);
  const [persistence, setPersistence] = useState<Persistence>({ mode: "loading" });
  const [corrections, setCorrections] = useState<ReadonlyMap<string, Correction>>(new Map());
  const [items, setItems] = useState<ReadonlyMap<string, LearningItem>>(new Map());
  const [playback, setPlayback] = useState<ReadonlyMap<string, PlaybackRecord>>(new Map());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const store = await openStore();
        const [storedCorrections, storedItems, storedPlayback] = await Promise.all([
          store.listCorrections(),
          store.listItems(),
          store.listPlayback(),
        ]);
        if (cancelled) return;
        storeRef.current = store;
        setCorrections(
          new Map(storedCorrections.map((c) => [correctionKey(c.episodeId, c.segmentId), c])),
        );
        setItems(new Map(storedItems.map((item) => [item.id, item])));
        // Merged, not replaced: anything saved this session before storage opened wins.
        setPlayback(
          (current) =>
            new Map([...storedPlayback.map((r) => [r.episodeId, r] as const), ...current]),
        );
        setPersistence({ mode: "persistent" });
      } catch (error) {
        if (cancelled) return;
        console.warn("Pebble: browser storage unavailable; using session-only data.", error);
        storeRef.current = null;
        setPersistence({ mode: "session", reason: "unavailable" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openStore]);

  const persist = useCallback((operation: (store: LearningStore) => Promise<void>) => {
    const store = storeRef.current;
    if (!store) return;
    operation(store).catch((error: unknown) => {
      console.warn("Pebble: a storage write failed; continuing session-only.", error);
      storeRef.current = null;
      setPersistence({ mode: "session", reason: "write-failed" });
    });
  }, []);

  const correctionFor = useCallback(
    (episodeId: string, segmentId: string) =>
      corrections.get(correctionKey(episodeId, segmentId)) ?? null,
    [corrections],
  );

  const itemForSegment = useCallback(
    (episodeId: string, segmentId: string) => {
      for (const item of items.values()) {
        if (item.episodeId === episodeId && item.segmentId === segmentId) return item;
      }
      return null;
    },
    [items],
  );

  const revertCorrection = useCallback(
    (episodeId: string, segmentId: string) => {
      setCorrections((current) => {
        const next = new Map(current);
        next.delete(correctionKey(episodeId, segmentId));
        return next;
      });
      persist((store) => store.deleteCorrection(episodeId, segmentId));
    },
    [persist],
  );

  const saveCorrection = useCallback(
    (episodeId: string, segment: Segment, text: string): CorrectionResult => {
      const corrected = text.trim();
      if (!corrected) return "empty";
      const existing = corrections.get(correctionKey(episodeId, segment.id));
      if (corrected === segment.text) {
        if (!existing) return "unchanged";
        revertCorrection(episodeId, segment.id);
        return "reverted";
      }
      if (existing?.correctedText === corrected) return "unchanged";
      const correction: Correction = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        episodeId,
        segmentId: segment.id,
        originalText: segment.text,
        correctedText: corrected,
        updatedAt: new Date().toISOString(),
      };
      setCorrections((current) =>
        new Map(current).set(correctionKey(episodeId, segment.id), correction),
      );
      persist((store) => store.putCorrection(correction));
      return "saved";
    },
    [corrections, persist, revertCorrection],
  );

  const saveItem = useCallback(
    (item: LearningItem) => {
      if (item.provenance.transcriptKind === "mock") {
        console.warn("Pebble: refused to save a learning item from a mock transcript.");
        return;
      }
      setItems((current) => new Map(current).set(item.id, item));
      persist((store) => store.putItem(item));
    },
    [persist],
  );

  const removeItem = useCallback(
    (id: string) => {
      setItems((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
      persist((store) => store.deleteItem(id));
    },
    [persist],
  );

  const updateNote = useCallback(
    (id: string, note: string) => {
      const item = items.get(id);
      if (!item) return;
      const updated: LearningItem = {
        ...item,
        note: note.trim() ? note : null,
        updatedAt: new Date().toISOString(),
      };
      saveItem(updated);
    },
    [items, saveItem],
  );

  const playbackFor = useCallback(
    (episodeId: string) => playback.get(episodeId) ?? null,
    [playback],
  );

  const savePlayback = useCallback(
    (record: PlaybackRecord) => {
      setPlayback((current) => new Map(current).set(record.episodeId, record));
      persist((store) => store.putPlayback(record));
    },
    [persist],
  );

  const clearPlayback = useCallback(
    (episodeId: string) => {
      setPlayback((current) => {
        if (!current.has(episodeId)) return current;
        const next = new Map(current);
        next.delete(episodeId);
        return next;
      });
      persist((store) => store.deletePlayback(episodeId));
    },
    [persist],
  );

  const markSourceDeleted = useCallback(
    (episodeId: string) => {
      clearPlayback(episodeId); // its listening position goes with the audio
      setCorrections((current) => {
        const next = new Map(current);
        for (const [key, correction] of current) {
          if (correction.episodeId === episodeId) next.delete(key);
        }
        return next;
      });
      persist((store) => store.deleteCorrectionsForEpisode(episodeId));

      const now = new Date().toISOString();
      const marked = [...items.values()]
        .filter((item) => item.episodeId === episodeId && !item.sourceDeletedAt)
        .map((item): LearningItem => ({ ...item, sourceDeletedAt: now, updatedAt: now }));
      if (marked.length === 0) return;
      setItems((current) => {
        const next = new Map(current);
        for (const item of marked) next.set(item.id, item);
        return next;
      });
      persist(async (store) => {
        for (const item of marked) await store.putItem(item);
      });
    },
    [items, persist, clearPlayback],
  );

  const resetAll = useCallback(() => {
    setCorrections(new Map());
    setItems(new Map());
    setPlayback(new Map());
    persist((store) => store.clear());
  }, [persist]);

  const value = useMemo<LearningContextValue>(
    () => ({
      persistence,
      corrections,
      items: [...items.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt)),
      correctionFor,
      itemForSegment,
      saveCorrection,
      revertCorrection,
      saveItem,
      removeItem,
      updateNote,
      markSourceDeleted,
      resetAll,
      playback,
      playbackFor,
      savePlayback,
      clearPlayback,
    }),
    [
      persistence,
      corrections,
      items,
      correctionFor,
      itemForSegment,
      saveCorrection,
      revertCorrection,
      saveItem,
      removeItem,
      updateNote,
      markSourceDeleted,
      resetAll,
      playback,
      playbackFor,
      savePlayback,
      clearPlayback,
    ],
  );

  return <LearningContext.Provider value={value}>{children}</LearningContext.Provider>;
}

export function useLearning(): LearningContextValue {
  const value = useContext(LearningContext);
  if (!value) throw new Error("useLearning must be used inside <LearningProvider>.");
  return value;
}
