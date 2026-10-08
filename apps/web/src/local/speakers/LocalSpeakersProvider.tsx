import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CURRENT_SCHEMA_VERSION, type Segment, type Transcript } from "@pebble/schema";
import type { MoreMenuItem } from "../../components/MoreMenu.tsx";
import {
  SpeakerOverlayContext,
  type SpeakerOverlay,
  type SpeakerOverlayOptions,
  type SpeakerOverlaySource,
} from "../../features/speakers/speakerOverlay.ts";
import { formatTime } from "../../lib/formatTime.ts";
import { LOCAL_EPISODE_ID } from "../workerClient.ts";
import { useWorker } from "../WorkerContext.tsx";
import {
  SPEAKER_CONFLICT_CHOOSE,
  SPEAKER_CONFLICT_COMBINED,
  SPEAKER_CONFLICT_DISCARDED,
  SPEAKER_CONFLICT_KEPT,
  SPEAKER_NOT_CARRIED,
  SPEAKER_UNSAVED_DROPPED,
  SPEAKERS,
  speakerRequestProblem,
} from "./speakerCopy.ts";
import {
  applyDraft,
  cleanNames,
  draftFrom,
  draftSavable,
  letterFor,
  mergeSpeaker,
  reassignLine,
  rebaseDraft,
  renameSpeaker,
  sameDraft,
  setNotSpeaker,
  unmergeSpeaker,
  visibleSpeakers,
  type SpeakerDraft,
} from "./speakerModel.ts";
import { SpeakerPanel } from "./SpeakerPanel.tsx";
import styles from "./SpeakerPanel.module.css";
import { useEpisodeSpeakers } from "./useEpisodeSpeakers.ts";

/**
 * The local reader's speaker overlay (ADR 0009). Only when the worker's health reports the
 * speaker capability and the transcript is real ASR; otherwise nothing is shown and nothing is
 * requested. Corrections are a draft for one detection until saved through the worker; the
 * transcript, English and saved items are never touched.
 */
function useLocalSpeakerOverlay(
  episodeId: string,
  transcript: Transcript,
  { focusMenu }: SpeakerOverlayOptions,
): SpeakerOverlay | null {
  const { client, status } = useWorker();
  const capability = status.kind === "ready" ? (status.health.speakers ?? null) : null;
  const enabled =
    capability !== null && transcript.provenance.kind === "asr" && LOCAL_EPISODE_ID.test(episodeId);
  const state = useEpisodeSpeakers(client, episodeId, enabled);
  const current = state.payload?.current ?? null;

  // The draft belongs to one detection; another detection starts from its own saved state.
  // `base` is the saved state the edits started from (for a three-way rebase on conflict).
  const [edit, setEdit] = useState<{
    runId: string;
    draft: SpeakerDraft;
    base: SpeakerDraft;
  } | null>(null);
  const saved = useMemo(() => (current ? draftFrom(current) : null), [current]);
  const mine = current && edit?.runId === current.runId ? edit : null;
  const draft = mine ? mine.draft : saved;
  const dirty = draft !== null && saved !== null && !sameDraft(draft, saved);
  // Clashing edits wait for an explicit choice; nothing is saved until the learner decides.
  const [clash, setClash] = useState<{ runId: string; count: number } | null>(null);
  const clashCount = clash && clash.runId === current?.runId ? clash.count : 0;
  const update = useCallback(
    (change: (draft: SpeakerDraft) => SpeakerDraft) => {
      if (!current || !draft || !saved) return;
      setEdit({ runId: current.runId, draft: change(draft), base: mine ? mine.base : saved });
    },
    [current, draft, mine, saved],
  );

  const [notice, setNotice] = useState<{ runId: string | null; text: string } | null>(null);
  const [correcting, setCorrecting] = useState(false);
  // The learner's explicit show/hide choice for this detection; null follows the default.
  const [shownChoice, setShownChoice] = useState<{ runId: string | null; open: boolean } | null>(
    null,
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);

  // A newer detection replaced the one on screen: say what wasn't carried over (in-session).
  const shown = useRef<{ runId: string; hadCorrections: boolean; dirty: boolean } | null>(null);
  useEffect(() => {
    const before = shown.current;
    if (current && before && before.runId !== current.runId) {
      const text = before.dirty
        ? SPEAKER_UNSAVED_DROPPED
        : before.hadCorrections
          ? SPEAKER_NOT_CARRIED
          : null;
      if (text) setNotice({ runId: current.runId, text });
    }
    if (current) {
      shown.current = { runId: current.runId, hadCorrections: current.corrections !== null, dirty };
    }
  }, [current, dirty]);
  const noticeText = notice && notice.runId === (current?.runId ?? null) ? notice.text : null;

  const effective = useMemo(
    () => (current && draft ? applyDraft(current.assignments, draft) : null),
    [current, draft],
  );
  const labels = useMemo(() => {
    const map = new Map<string, string | null>();
    if (effective) {
      for (const [segment, speaker] of Object.entries(effective)) {
        map.set(segment, speaker === null ? null : letterFor(speaker));
      }
    }
    return map;
  }, [effective]);
  // Spoken with the letter: only names already saved (confirmed), never an unsaved draft.
  const spokenNames = useMemo(() => {
    const map = new Map<string, string>();
    const confirmed = current?.corrections?.names ?? {};
    for (const [segment, speaker] of Object.entries(effective ?? {})) {
      const name = speaker === null ? undefined : confirmed[speaker];
      if (name) map.set(segment, name);
    }
    return map;
  }, [current, effective]);
  const lineCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const speaker of Object.values(effective ?? {})) {
      if (speaker !== null) counts.set(speaker, (counts.get(speaker) ?? 0) + 1);
    }
    return counts;
  }, [effective]);

  const save = useCallback(async () => {
    if (!current || !draft || !saved || clashCount > 0) return;
    const outcome = await state.save({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      episodeId,
      runId: current.runId,
      revision: current.corrections?.revision ?? 0,
      names: cleanNames(draft.names),
      merges: draft.merges,
      notSpeaker: draft.notSpeaker,
      lines: draft.lines,
    });
    switch (outcome.kind) {
      case "saved":
        setEdit(null);
        setShownChoice(null); // back to the default: tucked into the menu once saved
        setNotice({ runId: current.runId, text: SPEAKERS.savedTucked });
        focusMenu();
        break;
      case "conflict": {
        // Never save the old full draft over the newly saved corrections: rebase it three ways.
        const fresh = outcome.fresh?.current;
        if (!fresh || fresh.runId !== current.runId) break; // replaced: the run notice explains
        const theirs = draftFrom(fresh);
        const rebased = rebaseDraft(mine ? mine.base : saved, theirs, draft);
        if (rebased.conflicts.length === 0) {
          setEdit({ runId: fresh.runId, draft: rebased.draft, base: theirs });
          setNotice({ runId: fresh.runId, text: SPEAKER_CONFLICT_COMBINED });
        } else {
          setEdit({ runId: fresh.runId, draft, base: mine ? mine.base : saved });
          setClash({ runId: fresh.runId, count: rebased.conflicts.length });
          setNotice({
            runId: fresh.runId,
            text: SPEAKER_CONFLICT_CHOOSE(rebased.conflicts.length),
          });
        }
        break;
      }
      case "replaced":
        break; // the run-change notice explains it
      case "failed":
        setNotice({ runId: current.runId, text: speakerRequestProblem(outcome.code) });
        break;
    }
  }, [clashCount, current, draft, episodeId, focusMenu, mine, saved, state]);

  // The explicit decision after a clash: keep my draft (saved later, over the new revision) or
  // take the saved version.
  const keepMine = useCallback(() => {
    if (!current || !draft || !saved) return;
    setEdit({ runId: current.runId, draft, base: saved });
    setClash(null);
    setNotice({ runId: current.runId, text: SPEAKER_CONFLICT_KEPT });
  }, [current, draft, saved]);
  const useSaved = useCallback(() => {
    setEdit(null);
    setClash(null);
    // Taking the saved version isn't the learner's own save: keep the panel open to review it.
    if (current) setShownChoice({ runId: current.runId, open: true });
    setNotice(current ? { runId: current.runId, text: SPEAKER_CONFLICT_DISCARDED } : null);
  }, [current]);

  const visible = useMemo(
    () => (current && draft ? visibleSpeakers(current, draft) : []),
    [current, draft],
  );
  const lineAccessory = useMemo(() => {
    if (!correcting || !current || !draft || !effective) return null;
    return (segment: Segment) => {
      const detected = current.assignments[segment.id];
      if (detected === undefined) return null;
      const merged = detected === null ? null : (draft.merges[detected] ?? detected);
      const asDetected = merged !== null && !draft.notSpeaker.includes(merged) ? merged : null;
      const override = Object.hasOwn(draft.lines, segment.id) ? draft.lines[segment.id] : undefined;
      const value = override === undefined ? "auto" : override === null ? "none" : override;
      return (
        <select
          className={styles.lineSelect}
          aria-label={SPEAKERS.lineSelectLabel(formatTime(segment.startMs))}
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            update((d) =>
              reassignLine(
                d,
                segment.id,
                next === "auto" ? undefined : next === "none" ? null : next,
              ),
            );
          }}
        >
          <option value="auto">
            {SPEAKERS.asDetected(asDetected ? letterFor(asDetected) : null)}
          </option>
          {visible.map((id) => (
            <option key={id} value={id}>
              {letterFor(id)}
              {draft.names[id] ? ` — ${draft.names[id]}` : ""}
            </option>
          ))}
          <option value="none">{SPEAKERS.lineNotSpeaker}</option>
        </select>
      );
    };
  }, [correcting, current, draft, effective, update, visible]);

  // Once this detection's corrections are saved and nothing is pending, the panel is tucked into
  // the transcript actions menu. It stays open while a run is active or failed, or while there
  // are unsaved or clashing edits, so status and work are never hidden.
  const latest = state.payload?.latest ?? null;
  const settled = latest === null || latest.status === "completed";
  const hasSaved = current?.corrections != null;
  const tuckable = hasSaved && settled && !dirty && clashCount === 0;
  const choice =
    shownChoice && shownChoice.runId === (current?.runId ?? null) ? shownChoice.open : null;
  const panelOpen = choice ?? !tuckable;
  useEffect(() => {
    if (panelOpen && focusHeading.current && headingRef.current) {
      headingRef.current.focus();
      focusHeading.current = false;
    }
  }, [panelOpen]);
  const showPanel = useCallback(
    (open: boolean) => {
      setShownChoice({ runId: current?.runId ?? null, open });
      focusHeading.current = open;
    },
    [current],
  );

  if (!enabled || capability === null) return null;
  const menuItems: MoreMenuItem[] = hasSaved
    ? [
        {
          key: "speakers",
          label: panelOpen ? SPEAKERS.hidePanel : SPEAKERS.showPanel,
          onSelect: () => showPanel(!panelOpen),
        },
      ]
    : [];
  const conflictChoice =
    clashCount > 0 ? { count: clashCount, onKeepMine: keepMine, onUseSaved: useSaved } : null;
  const panel = (
    <SpeakerPanel
      capability={capability}
      payload={state.payload}
      draft={draft}
      lineCounts={lineCounts}
      dirty={dirty}
      savable={draft !== null && draftSavable(draft)}
      starting={state.starting}
      cancelling={state.cancelling}
      saving={state.saving}
      pollStopped={state.pollStopped}
      correcting={correcting}
      problem={state.problem}
      notice={noticeText}
      onStart={(count) => void state.start(count)}
      onCancel={() => void state.cancel()}
      onCheckAgain={state.checkAgain}
      onRename={(id, name) => update((d) => renameSpeaker(d, id, name))}
      onNotSpeaker={(id, hidden) => update((d) => setNotSpeaker(d, id, hidden))}
      onMerge={(source, target) => update((d) => mergeSpeaker(d, source, target))}
      onUnmerge={(source) => update((d) => unmergeSpeaker(d, source))}
      onToggleCorrecting={() => setCorrecting((on) => !on)}
      onSave={() => void save()}
      onDiscard={() => setEdit(null)}
      conflict={conflictChoice}
      headingRef={headingRef}
      onHide={
        hasSaved
          ? () => {
              showPanel(false);
              focusMenu();
            }
          : null
      }
    />
  );
  // Tucked away: the panel is gone, but its announcements (e.g. "saved") still reach screen readers.
  const tucked = (
    <p className={styles.visuallyHidden} role="status" aria-live="polite">
      {noticeText}
    </p>
  );
  return {
    labels: current ? labels : new Map(),
    spokenNames: current ? spokenNames : new Map(),
    panel: panelOpen ? panel : tucked,
    lineAccessory,
    menuItems,
  };
}

/** One constant source, so the hook is always the same function in the same order. */
const LOCAL_SPEAKERS: SpeakerOverlaySource = { useOverlay: useLocalSpeakerOverlay };

export function LocalSpeakersProvider({ children }: { children: ReactNode }) {
  return (
    <SpeakerOverlayContext.Provider value={LOCAL_SPEAKERS}>
      {children}
    </SpeakerOverlayContext.Provider>
  );
}
