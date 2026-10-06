import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

interface Cue {
  episodeId: string;
  segmentId: string;
  /** Where playback was sent: the line's start minus the pre-roll. */
  fromMs: number;
  token: number;
}

/** A seek landing this close to the cue's own start is the cue's seek, not an unrelated one. */
const OWN_SEEK_TOLERANCE_MS = 50;

/**
 * While a replayed line plays its short pre-roll, the playhead is still inside the previous
 * line. This keeps the replayed line highlighted for those few hundred milliseconds instead
 * of flicking back. The cue is dropped as soon as:
 * - playback reaches the line's start;
 * - playback pauses, fails, or never starts (`fail`);
 * - anything else seeks (arrow keys, the scrubber, resume, a learning-item cue…);
 * - the episode changes or the page unmounts (the state goes with it).
 * It never seeks or plays by itself, and only affects which line is shown as current.
 */
export function useReplayCue(
  audioRef: RefObject<HTMLAudioElement | null>,
  segments: readonly { id: string; startMs: number }[],
  episodeId: string,
  currentTimeMs: number,
) {
  const [cue, setCue] = useState<Cue | null>(null);
  // Event listeners need the cue as of now, not as of the last render.
  const cueRef = useRef<Cue | null>(null);
  const nextToken = useRef(0);
  const targetStart = useRef<number | null>(null);

  const update = useCallback((next: Cue | null) => {
    cueRef.current = next;
    setCue(next);
  }, []);

  const start = useCallback(
    (segment: { id: string; startMs: number }, fromMs: number) => {
      nextToken.current += 1;
      targetStart.current = segment.startMs;
      update({ episodeId, segmentId: segment.id, fromMs, token: nextToken.current });
      return nextToken.current;
    },
    [episodeId, update],
  );

  /** Playback didn't start for the cue with this token: drop it (a newer cue is kept). */
  const fail = useCallback(
    (token: number) => {
      if (cueRef.current?.token === token) update(null);
    },
    [update],
  );

  /** Another seek is about to happen: drop the cue now rather than wait for its event. */
  const clear = useCallback(() => {
    if (cueRef.current) update(null);
  }, [update]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onSeeking = () => {
      const current = cueRef.current;
      if (current && Math.abs(audio.currentTime * 1000 - current.fromMs) > OWN_SEEK_TOLERANCE_MS)
        update(null);
    };
    const onTimeUpdate = () => {
      const target = targetStart.current;
      if (cueRef.current && target !== null && audio.currentTime * 1000 >= target) update(null);
    };
    const listeners: [string, () => void][] = [
      ["pause", clear],
      ["ended", clear],
      ["error", clear],
      ["emptied", clear],
      ["seeking", onSeeking],
      ["timeupdate", onTimeUpdate],
    ];
    for (const [type, listener] of listeners) audio.addEventListener(type, listener);
    return () => {
      for (const [type, listener] of listeners) audio.removeEventListener(type, listener);
    };
  }, [audioRef, clear, update]);

  // Which line the cue holds as current right now, if any. Checked on every render, so the
  // hold ends the moment the playhead reaches the line even before an event clears it.
  let cuedIndex: number | null = null;
  if (cue && cue.episodeId === episodeId) {
    const index = segments.findIndex((s) => s.id === cue.segmentId);
    const segment = segments[index];
    if (
      segment &&
      currentTimeMs < segment.startMs &&
      currentTimeMs >= cue.fromMs - OWN_SEEK_TOLERANCE_MS
    ) {
      cuedIndex = index;
    }
  }

  return { cuedIndex, start, fail, clear };
}
