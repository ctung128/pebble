import { useId, useState, type RefObject } from "react";
import type { EpisodeSpeakers, SpeakerHealth } from "@pebble/schema";
import { ConfirmButton } from "../../components/ConfirmButton.tsx";
import {
  SPEAKER_CONFLICT_ACTIONS,
  SPEAKER_STATUS,
  SPEAKER_UNAVAILABLE,
  SPEAKERS,
  speakerFailure,
  speakerRequestProblem,
} from "./speakerCopy.ts";
import {
  canMergeOrHide,
  letterFor,
  mergeTargets,
  speakerNameProblem,
  visibleSpeakers,
  type SpeakerDraft,
  type SpeakerResult,
} from "./speakerModel.ts";
import styles from "./SpeakerPanel.module.css";

export interface SpeakerPanelProps {
  capability: SpeakerHealth;
  payload: EpisodeSpeakers | null;
  draft: SpeakerDraft | null;
  /** Lines per visible speaker with the draft applied. */
  lineCounts: ReadonlyMap<string, number>;
  dirty: boolean;
  savable: boolean;
  starting: boolean;
  cancelling: boolean;
  saving: boolean;
  pollStopped: boolean;
  correcting: boolean;
  /** A request that failed (a worker code); a fixed message is shown for it. */
  problem: string | null;
  /** A notice about saving, a conflict, or a replaced detection. */
  notice: string | null;
  onStart: (speakerCount: number | null) => void;
  onCancel: () => void;
  onCheckAgain: () => void;
  onRename: (id: string, name: string) => void;
  onNotSpeaker: (id: string, hidden: boolean) => void;
  onMerge: (source: string, target: string) => void;
  onUnmerge: (source: string) => void;
  onToggleCorrecting: () => void;
  onSave: () => void;
  onDiscard: () => void;
  /** The heading, focused when the panel is reopened from the menu. */
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** Tucks the panel into the transcript actions menu (once corrections are saved), or null. */
  onHide: (() => void) | null;
  /** After a clashing conflict: the explicit choice that must come before saving. */
  conflict: { count: number; onKeepMine: () => void; onUseSaved: () => void } | null;
}

/** What the key and its rows need: the panel's props without the heading ref. */
type KeyProps = Omit<SpeakerPanelProps, "headingRef">;

const parseHint = (text: string): number | null | "invalid" => {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= 15 ? n : "invalid";
};

/** The speaker key and controls for one episode (local mode only). */
export function SpeakerPanel({ headingRef, ...props }: SpeakerPanelProps) {
  const { capability, payload, draft } = props;
  const headingId = useId();
  const hintId = useId();
  const [hintText, setHintText] = useState("");
  const latest = payload?.latest ?? null;
  const current = payload?.current ?? null;
  const active = latest?.status === "queued" || latest?.status === "running";
  const available = capability.state === "ready";
  const hint = parseHint(hintText);

  let status = "";
  if (latest && active) {
    status = props.pollStopped
      ? SPEAKER_STATUS.pollStopped
      : latest.status === "queued"
        ? SPEAKER_STATUS.queued
        : SPEAKER_STATUS.running;
  } else if (latest?.status === "completed") status = SPEAKER_STATUS.done;
  const failure =
    latest && (latest.status === "failed" || latest.status === "cancelled") && latest.failure
      ? speakerFailure(latest.failure.code)
      : null;
  const unavailable = capability.state === "ready" ? null : SPEAKER_UNAVAILABLE[capability.state];

  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <div className={styles.titleRow}>
        <h2 id={headingId} className={styles.title} ref={headingRef} tabIndex={-1}>
          {SPEAKERS.heading}
        </h2>
        <span className={styles.badge}>{SPEAKERS.badge}</span>
        {props.onHide ? (
          <button type="button" className={styles.hide} onClick={props.onHide}>
            {SPEAKERS.hidePanel}
          </button>
        ) : null}
      </div>
      <p className={styles.note}>{SPEAKERS.disclosure}</p>

      <p className={styles.status} role="status" aria-live="polite">
        {[status, failure, props.notice].filter(Boolean).join(" ")}
      </p>
      {props.problem ? (
        <p className={styles.problem} role="alert">
          {speakerRequestProblem(props.problem)}
        </p>
      ) : null}

      {unavailable ? (
        <p className={styles.note}>
          {unavailable} {SPEAKER_UNAVAILABLE.keepReadable}
        </p>
      ) : null}

      <div className={styles.row}>
        {active ? (
          <button
            type="button"
            className={styles.button}
            disabled={props.cancelling}
            onClick={props.onCancel}
          >
            {SPEAKERS.cancel}
          </button>
        ) : available ? (
          <button
            type="button"
            className={styles.primary}
            disabled={props.starting || hint === "invalid"}
            onClick={() => props.onStart(hint === "invalid" ? null : hint)}
          >
            {props.starting ? SPEAKERS.starting : current ? SPEAKERS.detectAgain : SPEAKERS.detect}
          </button>
        ) : null}
        {active && props.pollStopped ? (
          <button type="button" className={styles.button} onClick={props.onCheckAgain}>
            {SPEAKERS.checkAgain}
          </button>
        ) : null}
      </div>
      {available && !active ? (
        <details>
          <summary>{SPEAKERS.advanced}</summary>
          <div className={styles.row}>
            <label htmlFor={hintId}>{SPEAKERS.hintLabel}</label>
            <input
              id={hintId}
              className={styles.input}
              inputMode="numeric"
              size={3}
              value={hintText}
              aria-describedby={`${hintId}-help`}
              aria-invalid={hint === "invalid" || undefined}
              onChange={(event) => setHintText(event.target.value)}
            />
          </div>
          <p id={`${hintId}-help`} className={styles.note}>
            {hint === "invalid" ? SPEAKERS.hintProblem : SPEAKERS.hintHelp}
          </p>
        </details>
      ) : null}

      {current && draft ? (
        <SpeakerKey {...props} current={current} draft={draft} />
      ) : !active ? (
        <p className={styles.note}>{SPEAKERS.none}</p>
      ) : null}
      <p className={styles.note}>{SPEAKERS.freshStart}</p>
    </section>
  );
}

function SpeakerKey(props: KeyProps & { current: SpeakerResult; draft: SpeakerDraft }) {
  const { current, draft } = props;
  const visible = visibleSpeakers(current, draft);
  const merged = Object.entries(draft.merges);
  const keyHeading = useId();
  return (
    <>
      <h3 id={keyHeading} className={styles.title}>
        {SPEAKERS.keyHeading}
      </h3>
      <ul className={styles.key} aria-labelledby={keyHeading}>
        {visible.map((id) => (
          <SpeakerRow key={id} {...props} id={id} />
        ))}
      </ul>
      {merged.length > 0 || draft.notSpeaker.length > 0 ? (
        <ul className={styles.key}>
          {merged.map(([source, target]) => {
            const row = SPEAKERS.mergedRow(letterFor(source), letterFor(target));
            return (
              <li key={source} className={styles.speaker}>
                <span>{row}</span>
                <button
                  type="button"
                  className={styles.button}
                  aria-label={SPEAKERS.undoLabel(row)}
                  onClick={() => props.onUnmerge(source)}
                >
                  {SPEAKERS.undo}
                </button>
              </li>
            );
          })}
          {draft.notSpeaker.map((id) => {
            const row = SPEAKERS.hiddenRow(letterFor(id));
            return (
              <li key={id} className={styles.speaker}>
                <span>{row}</span>
                <button
                  type="button"
                  className={styles.button}
                  aria-label={SPEAKERS.undoLabel(row)}
                  onClick={() => props.onNotSpeaker(id, false)}
                >
                  {SPEAKERS.undo}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {props.conflict ? (
        <div className={styles.row} role="group" aria-label={SPEAKER_CONFLICT_ACTIONS.keepMine}>
          <button type="button" className={styles.primary} onClick={props.conflict.onKeepMine}>
            {SPEAKER_CONFLICT_ACTIONS.keepMine}
          </button>
          <button type="button" className={styles.button} onClick={props.conflict.onUseSaved}>
            {SPEAKER_CONFLICT_ACTIONS.useSaved}
          </button>
        </div>
      ) : null}
      <div className={styles.row}>
        <button
          type="button"
          className={styles.button}
          aria-pressed={props.correcting}
          onClick={props.onToggleCorrecting}
        >
          {props.correcting ? SPEAKERS.doneCorrecting : SPEAKERS.correctLines}
        </button>
        <button
          type="button"
          className={styles.primary}
          disabled={!props.dirty || !props.savable || props.saving || props.conflict !== null}
          onClick={props.onSave}
        >
          {props.saving ? SPEAKERS.saving : SPEAKERS.save}
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={!props.dirty || props.saving}
          onClick={props.onDiscard}
        >
          {SPEAKERS.discard}
        </button>
      </div>
      {props.dirty ? (
        <p className={styles.note}>{props.savable ? SPEAKERS.unsaved : SPEAKERS.cantSave}</p>
      ) : null}
    </>
  );
}

function SpeakerRow(props: KeyProps & { current: SpeakerResult; draft: SpeakerDraft; id: string }) {
  const { current, draft, id } = props;
  const letter = letterFor(id);
  const nameId = useId();
  const mergeId = useId();
  const [target, setTarget] = useState("");
  const name = draft.names[id] ?? "";
  const problem = speakerNameProblem(name);
  const unlocked = canMergeOrHide(draft, id);
  const targets = mergeTargets(current, draft, id);
  const chosen = targets.includes(target) ? target : "";
  return (
    <li className={styles.speaker}>
      <span className={styles.letter} aria-hidden="true">
        {letter}
      </span>
      <label htmlFor={nameId} className={styles.visuallyHidden}>
        {SPEAKERS.nameLabel(letter)}
      </label>
      <input
        id={nameId}
        className={styles.input}
        value={name}
        placeholder={SPEAKERS.namePlaceholder}
        maxLength={120}
        aria-invalid={problem !== null || undefined}
        aria-describedby={problem ? `${nameId}-problem` : undefined}
        onChange={(event) => props.onRename(id, event.target.value)}
      />
      <span className={styles.count}>{SPEAKERS.lineCount(props.lineCounts.get(id) ?? 0)}</span>
      {problem ? (
        <span id={`${nameId}-problem`} className={styles.problem}>
          {problem}
        </span>
      ) : null}
      {unlocked ? (
        <>
          <button
            type="button"
            className={styles.button}
            aria-label={SPEAKERS.notSpeakerLabel(letter)}
            onClick={() => props.onNotSpeaker(id, true)}
          >
            {SPEAKERS.notSpeaker}
          </button>
          {targets.length > 0 ? (
            <>
              <label htmlFor={mergeId} className={styles.visuallyHidden}>
                {SPEAKERS.mergeLabel(letter)}
              </label>
              <select
                id={mergeId}
                className={styles.select}
                value={chosen}
                onChange={(event) => setTarget(event.target.value)}
              >
                <option value="">{SPEAKERS.mergeChoose}</option>
                {targets.map((other) => (
                  <option key={other} value={other}>
                    {letterFor(other)}
                    {draft.names[other] ? ` — ${draft.names[other]}` : ""}
                  </option>
                ))}
              </select>
              <ConfirmButton
                className={styles.button}
                disabled={chosen === ""}
                prompt={SPEAKERS.mergePrompt(letter, chosen ? letterFor(chosen) : "")}
                confirmLabel={SPEAKERS.mergeConfirm}
                onConfirm={() => {
                  if (chosen) props.onMerge(id, chosen);
                  setTarget("");
                }}
              >
                {SPEAKERS.mergeButton}
              </ConfirmButton>
            </>
          ) : null}
        </>
      ) : (
        <span className={styles.note}>{SPEAKERS.locked}</span>
      )}
    </li>
  );
}
