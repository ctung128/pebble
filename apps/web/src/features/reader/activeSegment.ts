/**
 * Index of the segment that is "current" at `timeMs`: the last segment whose start is at or
 * before the playhead. Gaps between lines keep the previous line active, which reads more
 * calmly than flickering to nothing. Returns -1 before the first segment starts.
 * Assumes segments are ordered by startMs (enforced by the transcript contract).
 */
export function findActiveSegmentIndex(
  segments: readonly { startMs: number }[],
  timeMs: number,
): number {
  let low = 0;
  let high = segments.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (segments[mid]!.startMs <= timeMs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}
