import { useId, useState, type ReactNode, type RefObject } from "react";
import type { EpisodeSpeakers, SpeakerHealth } from "@pebble/schema";
import { MoreMenu, type MoreMenuItem } from "../../components/MoreMenu.tsx";
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
  /** The heading, focused when the panel is reopened from the menu. */
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** Tucks the panel into the transcript actions menu. */
  onHide: () => void;
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

/** Fills for the letter avatars, in turn; they differ in lightness, not only hue. */
const AVATAR_TONES = ["toneA", "toneB", "toneC"] as const;
const toneOf = (index: number) => styles[AVATAR_TONES[index % AVATAR_TONES.length]!];
/** At most this many letters in the header's avatar stack; the rest are counted. */
const STACK_MAX = 4;

/**
 * The speaker card for one episode (local mode only). Its header always says where things stand
 * (not detected, detecting, or who was found); the body shows one thing at a time.
 */
export function SpeakerPanel({ headingRef, ...props }: SpeakerPanelProps) {
  const { capability, payload, draft } = props;
  const headingId = useId();
  const hintId = useId();
  const [hintText, setHintText] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const latest = payload?.latest ?? null;
  const current = payload?.current ?? null;
  const active = latest?.status === "queued" || latest?.status === "running";
  const available = capability.state === "ready";
  const hint = parseHint(hintText);
  const visible = current && draft ? visibleSpeakers(current, draft) : [];

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

  let summary: string = SPEAKERS.notDetected;
  if (active) summary = SPEAKERS.detecting;
  else if (current && draft) {
    const lines = visible.reduce((sum, id) => sum + (props.lineCounts.get(id) ?? 0), 0);
    summary = SPEAKERS.summary(visible.length, lines);
  }

  const detect =
    available && !active ? (
      <>
        <button
          type="button"
          className={current ? styles.link : styles.button}
          disabled={props.starting || hint === "invalid"}
          onClick={() => props.onStart(hint === "invalid" ? null : hint)}
        >
          {props.starting ? SPEAKERS.starting : current ? SPEAKERS.detectAgain : SPEAKERS.detect}
        </button>
        <button
          type="button"
          className={styles.link}
          aria-expanded={advancedOpen}
          aria-controls={advancedOpen ? `${hintId}-advanced` : undefined}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          {SPEAKERS.advanced}
        </button>
      </>
    ) : null;
  const advanced =
    detect && advancedOpen ? (
      <div id={`${hintId}-advanced`} className={styles.advanced}>
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
      </div>
    ) : null;

  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <header className={styles.header}>
        {active ? (
          <span className={styles.stack} aria-hidden="true">
            <span className={styles.pending} />
            <span className={styles.pending} />
            <span className={styles.pending} />
          </span>
        ) : visible.length > 0 ? (
          <span className={styles.stack} aria-hidden="true">
            {visible.slice(0, STACK_MAX).map((id, index) => (
              <span key={id} className={`${styles.avatar} ${toneOf(index)}`}>
                {letterFor(id)}
              </span>
            ))}
            {visible.length > STACK_MAX ? (
              <span className={`${styles.avatar} ${styles.more}`}>
                +{visible.length - STACK_MAX}
              </span>
            ) : null}
          </span>
        ) : (
          <svg
            className={styles.glyph}
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <circle cx="9" cy="8" r="3.5" />
            <path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5" />
            <path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14.8c1.6.9 2.6 2.6 3 5.2" />
          </svg>
        )}
        <div className={styles.heading}>
          <div className={styles.titleRow}>
            <h2 id={headingId} className={styles.title} ref={headingRef} tabIndex={-1}>
              {SPEAKERS.heading}
            </h2>
            <span className={styles.badge}>{SPEAKERS.badge}</span>
          </div>
          <span className={active ? styles.summaryActive : styles.summary}>{summary}</span>
        </div>
        <button type="button" className={styles.hide} onClick={props.onHide}>
          {SPEAKERS.hidePanel}
        </button>
      </header>

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

      {active ? (
        <div className={styles.row}>
          <button
            type="button"
            className={styles.button}
            disabled={props.cancelling}
            onClick={props.onCancel}
          >
            {SPEAKERS.cancel}
          </button>
          {props.pollStopped ? (
            <button type="button" className={styles.button} onClick={props.onCheckAgain}>
              {SPEAKERS.checkAgain}
            </button>
          ) : null}
        </div>
      ) : null}

      {current && draft ? (
        <SpeakerKey {...props} current={current} draft={draft} visible={visible} detect={detect} />
      ) : detect ? (
        <div className={styles.row}>{detect}</div>
      ) : null}
      {advanced}
    </section>
  );
}

type KeyOwnProps = {
  current: SpeakerResult;
  draft: SpeakerDraft;
  visible: string[];
  /** Detect again and Advanced, in the bottom row; null while detection can't start. */
  detect: ReactNode;
};

function SpeakerKey(props: KeyProps & KeyOwnProps) {
  const { draft, visible } = props;
  const merged = Object.entries(draft.merges);
  const keyHeading = useId();
  return (
    <>
      <h3 id={keyHeading} className={styles.visuallyHidden}>
        {SPEAKERS.keyHeading}
      </h3>
      <ul className={styles.tiles} aria-labelledby={keyHeading}>
        {visible.map((id, index) => (
          <SpeakerTile key={id} {...props} id={id} tone={toneOf(index)} />
        ))}
        {merged.map(([source, target]) => (
          <TuckedTile
            key={source}
            row={SPEAKERS.mergedRow(letterFor(source), letterFor(target))}
            onUndo={() => props.onUnmerge(source)}
          />
        ))}
        {draft.notSpeaker.map((id) => (
          <TuckedTile
            key={id}
            row={SPEAKERS.hiddenRow(letterFor(id))}
            onUndo={() => props.onNotSpeaker(id, false)}
          />
        ))}
      </ul>
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
        {props.detect}
        <button
          type="button"
          className={styles.save}
          disabled={!props.dirty || !props.savable || props.saving || props.conflict !== null}
          onClick={props.onSave}
        >
          {props.saving ? SPEAKERS.saving : SPEAKERS.save}
        </button>
      </div>
      {props.dirty ? (
        <p className={styles.note}>{props.savable ? SPEAKERS.unsaved : SPEAKERS.cantSave}</p>
      ) : null}
    </>
  );
}

/** A merged or not-a-speaker cluster: what happened to it, and a way back. */
function TuckedTile({ row, onUndo }: { row: string; onUndo: () => void }) {
  return (
    <li className={styles.tucked}>
      <span>{row}</span>
      <button
        type="button"
        className={styles.link}
        aria-label={SPEAKERS.undoLabel(row)}
        onClick={onUndo}
      >
        {SPEAKERS.undo}
      </button>
    </li>
  );
}

function SpeakerTile(props: KeyProps & KeyOwnProps & { id: string; tone: string | undefined }) {
  const { current, draft, id } = props;
  const letter = letterFor(id);
  const nameId = useId();
  const [pending, setPending] = useState<string | null>(null);
  const name = draft.names[id] ?? "";
  const problem = speakerNameProblem(name);
  const unlocked = canMergeOrHide(draft, id);
  const targets = mergeTargets(current, draft, id);
  const target = pending && targets.includes(pending) ? pending : null;
  const items: MoreMenuItem[] = [
    ...targets.map((other) => ({
      key: `merge-${other}`,
      label: SPEAKERS.mergeInto(letterFor(other), draft.names[other]?.trim() ?? ""),
      onSelect: () => setPending(other),
    })),
    { key: "hide", label: SPEAKERS.notSpeaker, onSelect: () => props.onNotSpeaker(id, true) },
  ];
  return (
    <li className={styles.tile}>
      <div className={styles.tileTop}>
        <span
          className={`${styles.avatar} ${styles.avatarLg} ${props.tone ?? ""}`}
          aria-hidden="true"
        >
          {letter}
        </span>
        <span className={styles.count}>{SPEAKERS.lineCount(props.lineCounts.get(id) ?? 0)}</span>
        {unlocked ? <MoreMenu label={SPEAKERS.actionsLabel(letter)} items={items} /> : null}
      </div>
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
      {problem ? (
        <span id={`${nameId}-problem`} className={styles.problem}>
          {problem}
        </span>
      ) : null}
      {unlocked ? null : <span className={styles.note}>{SPEAKERS.locked}</span>}
      {target ? (
        <div
          className={styles.confirm}
          role="group"
          aria-label={SPEAKERS.mergePrompt(letter, letterFor(target))}
          onKeyDown={(event) => event.key === "Escape" && setPending(null)}
        >
          <span>{SPEAKERS.mergePrompt(letter, letterFor(target))}</span>
          <div className={styles.row}>
            <button type="button" className={styles.link} onClick={() => setPending(null)}>
              {SPEAKERS.mergeCancel}
            </button>
            <button
              type="button"
              className={styles.button}
              autoFocus
              onClick={() => {
                setPending(null);
                props.onMerge(id, target);
              }}
            >
              {SPEAKERS.mergeConfirm}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
