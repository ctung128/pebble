import { useEffect, useRef, type RefObject } from "react";
import { useLearning } from "../learning/LearningContext.tsx";

/** While playing, the position is saved at most this often. */
export const SAVE_INTERVAL_MS = 15_000;
/** Moves smaller than this aren't worth a write. */
export const MIN_SAVE_MOVE_MS = 1_000;

const toMs = (seconds: number) => Math.round(seconds * 1000);

/**
 * Saves where the learner is in an episode, browser-locally and conservatively:
 * - only after the audio has actually played this visit (opening or scrubbing alone saves
 *   nothing);
 * - at most every 15 s while playing, and right away on pause, end, the page being hidden or
 *   unloaded, and leaving the episode;
 * - "finished" only from the audio's real `ended` event, kept until playback starts again.
 * It never starts or seeks playback itself.
 */
export function usePlaybackProgress(
  audioRef: RefObject<HTMLAudioElement | null>,
  episodeId: string,
  /** The episode's known length, used until the media reports its own. */
  expectedDurationMs: number,
): void {
  const { savePlayback } = useLearning();
  // The latest save function, so listeners registered once always use it.
  const latest = useRef({ savePlayback, episodeId, expectedDurationMs });
  useEffect(() => {
    latest.current = { savePlayback, episodeId, expectedDurationMs };
  });

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    let played = false;
    let finishedAt: string | null = null;
    let lastSaved: number | null = null;
    let timer: number | undefined;

    const duration = () =>
      Number.isFinite(audio.duration) && audio.duration > 0
        ? toMs(audio.duration)
        : latest.current.expectedDurationMs;

    const save = (force = false) => {
      if (!played) return;
      const durationMs = duration();
      if (!(durationMs > 0)) return;
      const positionMs = finishedAt ? durationMs : Math.min(toMs(audio.currentTime), durationMs);
      if (!force && lastSaved !== null && Math.abs(positionMs - lastSaved) < MIN_SAVE_MOVE_MS) {
        return;
      }
      lastSaved = positionMs;
      latest.current.savePlayback({
        episodeId: latest.current.episodeId,
        positionMs,
        durationMs,
        updatedAt: new Date().toISOString(),
        finishedAt,
      });
    };

    const onPlay = () => {
      played = true;
      finishedAt = null; // listening again: no longer "finished" once a new position is saved
      window.clearInterval(timer);
      timer = window.setInterval(() => save(), SAVE_INTERVAL_MS);
    };
    const onPause = () => {
      window.clearInterval(timer);
      timer = undefined;
      save();
    };
    const onEnded = () => {
      window.clearInterval(timer);
      timer = undefined;
      if (!played) return;
      finishedAt = new Date().toISOString();
      save(true);
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") save();
    };
    const onPageHide = () => save();

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.clearInterval(timer);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
      save(); // leaving the episode (another page, or another episode)
    };
  }, [audioRef]);
}
