import {
  MAX_SPEAKER_NAME_CODE_POINTS,
  speakerCorrectionIssues,
  type EpisodeSpeakers,
} from "@pebble/schema";

/** A completed detection, as the worker reports it. */
export type SpeakerResult = NonNullable<EpisodeSpeakers["current"]>;

/**
 * The learner's corrections for one detection (run), before or after saving. Names are kept as
 * typed until saving; `lines` maps a segment id to a speaker id, or null for not-a-speaker.
 */
export interface SpeakerDraft {
  names: Record<string, string>;
  merges: Record<string, string>;
  notSpeaker: string[];
  lines: Record<string, string | null>;
}

export const EMPTY_DRAFT: SpeakerDraft = { names: {}, merges: {}, notSpeaker: [], lines: {} };

/** The saved corrections of a detection, as a draft to edit (a copy). */
export function draftFrom(current: SpeakerResult): SpeakerDraft {
  const saved = current.corrections;
  if (!saved) return { names: {}, merges: {}, notSpeaker: [], lines: {} };
  return {
    names: { ...saved.names },
    merges: { ...saved.merges },
    notSpeaker: [...saved.notSpeaker],
    lines: { ...saved.lines },
  };
}

/** S1 → "A", S2 → "B", … S26 → "Z"; beyond that the generic id itself. */
export function letterFor(speakerId: string): string {
  const n = Number(speakerId.slice(1));
  return n >= 1 && n <= 26 ? String.fromCharCode(64 + n) : speakerId;
}

/** Names as they will be saved: trimmed and NFC-normalized, empty ones dropped. */
export function cleanNames(names: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [id, name] of Object.entries(names)) {
    const value = name.normalize("NFC").trim();
    if (value) clean[id] = value;
  }
  return clean;
}

const sorted = (record: Record<string, unknown>) =>
  JSON.stringify(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]]),
  );

/** Whether two drafts would save the same corrections. */
export function sameDraft(a: SpeakerDraft, b: SpeakerDraft): boolean {
  return (
    sorted(cleanNames(a.names)) === sorted(cleanNames(b.names)) &&
    sorted(a.merges) === sorted(b.merges) &&
    JSON.stringify([...a.notSpeaker].sort()) === JSON.stringify([...b.notSpeaker].sort()) &&
    sorted(a.lines) === sorted(b.lines)
  );
}

/**
 * The worker's rule (store.apply_corrections): a line reassignment wins; otherwise merges, then
 * not-a-speaker clusters, apply. Only visible speakers (or null) come out.
 */
export function applyDraft(
  assignments: Record<string, string | null>,
  draft: SpeakerDraft,
): Record<string, string | null> {
  const hidden = new Set(draft.notSpeaker);
  const effective: Record<string, string | null> = {};
  for (const [segment, speaker] of Object.entries(assignments)) {
    if (Object.hasOwn(draft.lines, segment)) {
      effective[segment] = draft.lines[segment] ?? null;
      continue;
    }
    const merged = speaker === null ? null : (draft.merges[speaker] ?? speaker);
    effective[segment] = merged !== null && hidden.has(merged) ? null : merged;
  }
  return effective;
}

/** Speakers still shown in the key: not merged away and not marked not-a-speaker. */
export function visibleSpeakers(current: SpeakerResult, draft: SpeakerDraft): string[] {
  return current.speakers
    .map((speaker) => speaker.id)
    .filter((id) => !(id in draft.merges) && !draft.notSpeaker.includes(id));
}

const isMergeTarget = (draft: SpeakerDraft, id: string) => Object.values(draft.merges).includes(id);

/** A speaker others were merged into can't itself be merged or hidden (no chains). */
export function canMergeOrHide(draft: SpeakerDraft, id: string): boolean {
  return !isMergeTarget(draft, id);
}

/** Where `source` can be merged: other visible speakers. */
export function mergeTargets(
  current: SpeakerResult,
  draft: SpeakerDraft,
  source: string,
): string[] {
  return visibleSpeakers(current, draft).filter((id) => id !== source);
}

export function renameSpeaker(draft: SpeakerDraft, id: string, name: string): SpeakerDraft {
  const names = { ...draft.names };
  if (name === "") delete names[id];
  else names[id] = name;
  return { ...draft, names };
}

/** Marks or unmarks a cluster as not a speaker; lines reassigned to it go back to as-detected. */
export function setNotSpeaker(draft: SpeakerDraft, id: string, hidden: boolean): SpeakerDraft {
  if (!hidden) return { ...draft, notSpeaker: draft.notSpeaker.filter((s) => s !== id) };
  if (draft.notSpeaker.includes(id) || isMergeTarget(draft, id) || id in draft.merges) return draft;
  const lines = Object.fromEntries(Object.entries(draft.lines).filter(([, s]) => s !== id));
  return { ...draft, notSpeaker: [...draft.notSpeaker, id], lines };
}

/** Shows `source`'s lines as `target`; its name and line reassignments move to the target. */
export function mergeSpeaker(draft: SpeakerDraft, source: string, target: string): SpeakerDraft {
  if (source === target || isMergeTarget(draft, source) || target in draft.merges) return draft;
  if (draft.notSpeaker.includes(source) || draft.notSpeaker.includes(target)) return draft;
  const names = { ...draft.names };
  delete names[source];
  const lines = Object.fromEntries(
    Object.entries(draft.lines).map(([segment, s]) => [segment, s === source ? target : s]),
  );
  return { ...draft, names, lines, merges: { ...draft.merges, [source]: target } };
}

export function unmergeSpeaker(draft: SpeakerDraft, source: string): SpeakerDraft {
  const merges = { ...draft.merges };
  delete merges[source];
  return { ...draft, merges };
}

/** `undefined`: back to as-detected; null: not a speaker; otherwise a visible speaker id. */
export function reassignLine(
  draft: SpeakerDraft,
  segmentId: string,
  speaker: string | null | undefined,
): SpeakerDraft {
  const lines = { ...draft.lines };
  if (speaker === undefined) delete lines[segmentId];
  else lines[segmentId] = speaker;
  return { ...draft, lines };
}

const isControl = (cp: number) => cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);

/** Why a typed name can't be saved, or null (an empty name just removes it). */
export function speakerNameProblem(name: string): string | null {
  const value = name.normalize("NFC").trim();
  if (!value) return null;
  const codePoints = Array.from(value, (char) => char.codePointAt(0) ?? 0);
  if (codePoints.length > MAX_SPEAKER_NAME_CODE_POINTS || codePoints.some(isControl)) {
    return `Use up to ${MAX_SPEAKER_NAME_CODE_POINTS} characters, on one line.`;
  }
  return null;
}

/** Whether the draft can be saved as it stands (names and the shared correction rules). */
export function draftSavable(draft: SpeakerDraft): boolean {
  if (Object.values(draft.names).some((name) => speakerNameProblem(name) !== null)) return false;
  return (
    speakerCorrectionIssues({
      names: cleanNames(draft.names),
      merges: draft.merges,
      notSpeaker: draft.notSpeaker,
      lines: draft.lines,
    }).length === 0
  );
}

/** One field both sides changed differently (or a combination the rules don't allow). */
export interface SpeakerConflictItem {
  kind: "name" | "merge" | "notSpeaker" | "line" | "rules";
  key: string;
}

const ABSENT = Symbol("absent");
type Slot<T> = T | typeof ABSENT;

function threeWay<T>(
  base: Record<string, T>,
  theirs: Record<string, T>,
  mine: Record<string, T>,
  kind: SpeakerConflictItem["kind"],
  same: (a: Slot<T>, b: Slot<T>) => boolean,
  conflicts: SpeakerConflictItem[],
): Record<string, T> {
  const at = (record: Record<string, T>, key: string): Slot<T> =>
    Object.hasOwn(record, key) ? (record[key] as T) : ABSENT;
  const result: Record<string, T> = {};
  const keys = [...new Set([...Object.keys(base), ...Object.keys(theirs), ...Object.keys(mine)])];
  for (const key of keys.sort()) {
    const b = at(base, key);
    const t = at(theirs, key);
    const m = at(mine, key);
    let chosen: Slot<T>;
    if (same(m, b))
      chosen = t; // only they changed it (or nobody did)
    else if (same(t, b) || same(t, m))
      chosen = m; // only I changed it, or we agree
    else {
      conflicts.push({ kind, key });
      chosen = t; // keep the saved value until the learner decides
    }
    if (chosen !== ABSENT) result[key] = chosen;
  }
  return result;
}

const sameValue = <T>(a: Slot<T>, b: Slot<T>) => a === b;
const sameName = (a: Slot<string>, b: Slot<string>) =>
  (a === ABSENT ? "" : a.normalize("NFC").trim()) ===
  (b === ABSENT ? "" : b.normalize("NFC").trim());
const asSet = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, true as const]));

/**
 * Three-way rebase after a revision conflict: `base` is the saved state my edits started from,
 * `theirs` the newly saved state, `mine` my draft. Per name, merge, not-a-speaker entry and line,
 * a change made on one side only is kept; the same change on both sides agrees; different changes
 * to the same field are conflicts, and so is a combination the correction rules don't allow. The
 * result is never saved automatically.
 */
export function rebaseDraft(
  base: SpeakerDraft,
  theirs: SpeakerDraft,
  mine: SpeakerDraft,
): { draft: SpeakerDraft; conflicts: SpeakerConflictItem[] } {
  const conflicts: SpeakerConflictItem[] = [];
  const draft: SpeakerDraft = {
    names: threeWay(base.names, theirs.names, mine.names, "name", sameName, conflicts),
    merges: threeWay(base.merges, theirs.merges, mine.merges, "merge", sameValue, conflicts),
    notSpeaker: Object.keys(
      threeWay(
        asSet(base.notSpeaker),
        asSet(theirs.notSpeaker),
        asSet(mine.notSpeaker),
        "notSpeaker",
        sameValue,
        conflicts,
      ),
    ),
    lines: threeWay(base.lines, theirs.lines, mine.lines, "line", sameValue, conflicts),
  };
  if (conflicts.length === 0 && !draftSavable(draft)) conflicts.push({ kind: "rules", key: "" });
  return { draft, conflicts };
}
