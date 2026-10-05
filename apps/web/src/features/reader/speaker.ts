/**
 * The words for a transcript's own speaker label (e.g. the demo's authored "A" → "Speaker A").
 * Only labels already in the transcript are shown; Pebble never infers or invents speakers.
 */
export function speakerLabel(speaker: string): string {
  return `Speaker ${speaker}`;
}
