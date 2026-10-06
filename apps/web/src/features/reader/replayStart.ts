/** How far before a line's start "play this line" begins, so its first syllable isn't clipped. */
export const REPLAY_PREROLL_MS = 200;

/**
 * Where replaying the line at `index` starts: up to REPLAY_PREROLL_MS before it, but never
 * before 0 or before the previous line's *start*.
 *
 * The floor is the previous line's start, not its end: lines usually touch (one ends where the
 * next begins) and may overlap a little, so clamping to the previous end would almost always
 * remove the pre-roll. Starting inside the previous line's last moments is the point; jumping
 * back over a whole line is not. Only a previous line shorter than the pre-roll shortens it.
 * Stored timestamps are never changed.
 */
export function replayStartMs(segments: readonly { startMs: number }[], index: number): number {
  const segment = segments[index];
  if (!segment) return 0;
  const floor = segments[index - 1]?.startMs ?? 0;
  return Math.min(segment.startMs, Math.max(0, floor, segment.startMs - REPLAY_PREROLL_MS));
}
