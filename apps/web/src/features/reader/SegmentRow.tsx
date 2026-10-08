import { memo, useEffect, useRef, type ReactNode } from "react";
import type { Segment } from "@pebble/schema";
import { Icon } from "../../components/Icon.tsx";
import { formatTime } from "../../lib/formatTime.ts";
import { CorrectionEditor } from "../corrections/CorrectionEditor.tsx";
import { CopyFallback } from "./CopyFallback.tsx";
import { COPY_HELP, COPY_LABEL, useCopyText } from "./copyText.ts";
import type { LineActions, LineView } from "./lineView.ts";
import styles from "./TranscriptReader.module.css";

interface SegmentRowProps {
  segment: Segment;
  state: "past" | "active" | "upcoming";
  /** The transcript has speaker labels: every line gets the speaker slot (design system). */
  speakers: boolean;
  language: string;
  view: LineView;
  actions: LineActions;
  reviewDescriptionId: string;
  lockedDescriptionId?: string | undefined;
  showTranslation?: boolean;
  showCopy?: boolean;
  /** An extra control at the end of the line's actions (local mode), or null. */
  lineAccessory?: ((segment: Segment) => ReactNode) | null;
  /** A confirmed speaker name, announced after the letter; never visible line text. */
  speakerName?: string | null;
}

export const SegmentRow = memo(function SegmentRow({
  segment,
  state,
  speakers,
  language,
  view,
  actions,
  reviewDescriptionId,
  lockedDescriptionId,
  showTranslation = true,
  showCopy = false,
  lineAccessory = null,
  speakerName = null,
}: SegmentRowProps) {
  // Locked actions stay focusable and visible (discoverable) but do nothing.
  const locked = lockedDescriptionId !== undefined;
  const lockProps = locked
    ? ({ "aria-disabled": true, "aria-describedby": lockedDescriptionId } as const)
    : {};
  const time = formatTime(segment.startMs);
  const translationId = `translation-${segment.id}`;
  // A line may hide its own English action (e.g. local English isn't set up and it has none).
  const translationAction = showTranslation && !view.translationHidden;
  const translationOpen = translationAction && (view.translation?.open ?? false);
  // Copy state is per row and short-lived; it never leaves this component.
  const copy = useCopyText();
  const copyFailed = showCopy && copy.status === "failed";
  const copyButton = useRef<HTMLButtonElement>(null);
  // "Expanded" lines keep their actions visible; a review flag alone doesn't expand a line.
  const expanded =
    view.correction !== null ||
    view.pinyin.visible ||
    translationOpen ||
    view.editing ||
    view.confirmingUnsave ||
    copyFailed;
  const hasDetails = expanded || view.needsReview;

  // Return focus to the Edit button when the editor closes.
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(view.editing);
  useEffect(() => {
    if (wasEditing.current && !view.editing) editButton.current?.focus();
    wasEditing.current = view.editing;
  }, [view.editing]);

  return (
    <div
      className={styles.row}
      data-state={state}
      data-open={expanded || undefined}
      data-speakers={speakers || undefined}
    >
      <button
        type="button"
        className={styles.play}
        aria-current={state === "active" ? "true" : undefined}
        aria-describedby={view.needsReview ? reviewDescriptionId : undefined}
        onClick={() => actions.select(segment)}
      >
        <span className={styles.meta}>
          {/* Always laid out, so times line up whether or not the line is current. */}
          <span className={styles.marker} aria-hidden="true" />
          <span className={styles.time}>{time}</span>
        </span>
        {/* Spaces keep the button's name "0:13 Speaker A 你好"; flex and grid layout ignore them. */}{" "}
        <span className={styles.line}>
          {speakers ? (
            // The transcript's own label, on every line (the slot stays when a line has none, so
            // the Chinese lines up). Screen readers hear "Speaker A"; the page shows "A".
            <>
              <span className={styles.speaker}>
                {segment.speaker ? (
                  <>
                    <span className={styles.visuallyHidden}>Speaker</span> {segment.speaker}
                    {speakerName ? (
                      <span className={styles.visuallyHidden}>, {speakerName}</span>
                    ) : null}
                  </>
                ) : null}
              </span>{" "}
            </>
          ) : null}
          <span className={styles.text} lang={language} data-review={view.needsReview || undefined}>
            {view.text}
          </span>
        </span>
      </button>

      <div className={styles.actions} role="group" aria-label={`Line at ${time}`}>
        <button
          type="button"
          className={styles.action}
          aria-pressed={view.pinyin.visible}
          title="Pinyin (P)"
          {...lockProps}
          onClick={() => actions.togglePinyin(segment)}
        >
          <span aria-hidden="true" className={styles.glyph}>
            ā
          </span>
          <span className={styles.visuallyHidden}>Pinyin</span>
        </button>
        {translationAction ? (
          <button
            type="button"
            className={styles.action}
            aria-expanded={translationOpen}
            aria-controls={translationOpen ? translationId : undefined}
            title="English (T)"
            {...lockProps}
            onClick={() => actions.toggleTranslation(segment)}
          >
            <span aria-hidden="true" className={styles.glyph}>
              EN
            </span>
            <span className={styles.visuallyHidden}>English</span>
          </button>
        ) : null}
        {showCopy ? (
          <button
            ref={copyButton}
            type="button"
            className={styles.action}
            aria-label={COPY_LABEL}
            title={copy.status === "copied" ? "Copied" : COPY_HELP}
            onClick={() => copy.copy(view.text)}
          >
            <Icon name={copy.status === "copied" ? "check" : "copy"} size={18} />
          </button>
        ) : null}
        <button
          type="button"
          className={styles.action}
          aria-pressed={view.saved}
          title={view.saved ? "Saved as a learning item (S)" : "Save as a learning item (S)"}
          {...lockProps}
          onClick={() => actions.toggleSave(segment)}
        >
          <Icon name={view.saved ? "bookmarkFilled" : "bookmark"} size={18} />
          <span className={styles.visuallyHidden}>{view.saved ? "Saved" : "Save"}</span>
        </button>
        <button
          ref={editButton}
          type="button"
          className={styles.action}
          aria-pressed={view.editing}
          title="Edit line"
          {...lockProps}
          onClick={() => (view.editing ? actions.cancelEdit() : actions.startEdit(segment))}
        >
          <Icon name="edit" size={18} />
          <span className={styles.visuallyHidden}>Edit</span>
        </button>
        {showCopy ? (
          <span className={styles.visuallyHidden} role="status">
            {copy.status === "copied" ? "Copied" : ""}
          </span>
        ) : null}
        {lineAccessory ? lineAccessory(segment) : null}
      </div>

      {hasDetails ? (
        <div className={styles.details}>
          {view.pinyin.visible ? (
            <p className={styles.pinyin} lang="zh-Latn-pinyin">
              {view.pinyin.status === "ready" ? (
                view.pinyin.text
              ) : view.pinyin.status === "loading" ? (
                <span className={styles.muted}>Loading pinyin…</span>
              ) : (
                <span className={styles.muted}>
                  Pinyin couldn't load.{" "}
                  <button type="button" className={styles.link} onClick={actions.retryPinyin}>
                    Try again
                  </button>
                </span>
              )}
            </p>
          ) : null}

          {view.needsReview ? <span className={styles.reviewTag}>May need review</span> : null}

          {translationOpen && view.translation ? (
            <div id={translationId} className={styles.translation} aria-live="polite">
              {view.translation.status === "loading" ? (
                <span className={styles.muted}>Loading translation…</span>
              ) : view.translation.status === "ready" ? (
                <>
                  {view.translation.stale ? (
                    <p className={styles.muted}>
                      {view.translation.stale.label}{" "}
                      <button
                        type="button"
                        className={styles.link}
                        onClick={() => actions.retryTranslation(segment)}
                      >
                        {view.translation.stale.action}
                      </button>
                    </p>
                  ) : null}
                  <p lang="en">{view.translation.text}</p>
                  {view.translation.attribution ? (
                    <p className={styles.attribution}>
                      <a
                        href={view.translation.attribution.href}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {view.translation.attribution.text}
                      </a>
                    </p>
                  ) : null}
                </>
              ) : (
                <p className={styles.muted}>
                  {view.translation.message}{" "}
                  {view.translation.retryable ? (
                    <button
                      type="button"
                      className={styles.link}
                      onClick={() => actions.retryTranslation(segment)}
                    >
                      Try again
                    </button>
                  ) : null}
                </p>
              )}
            </div>
          ) : null}

          {view.correction && !view.editing ? (
            <div className={styles.edited}>
              <span className={styles.editedTag}>Edited by you</span>
              <button
                type="button"
                className={styles.link}
                aria-expanded={view.showOriginal}
                onClick={() => actions.toggleOriginal(segment)}
              >
                {view.showOriginal ? "Hide original" : "Show original"}
              </button>
              <button type="button" className={styles.link} onClick={() => actions.revert(segment)}>
                Revert
              </button>
              {view.showOriginal ? (
                <p className={styles.original}>
                  Original transcript: <span lang={language}>{view.correction.originalText}</span>
                </p>
              ) : null}
            </div>
          ) : null}

          {view.editing ? (
            <CorrectionEditor
              initialText={view.text}
              language={language}
              onSave={(text) => actions.saveEdit(segment, text)}
              onCancel={actions.cancelEdit}
            />
          ) : null}

          {copyFailed ? (
            <CopyFallback
              text={view.text}
              language={language}
              onClose={() => {
                copy.dismiss();
                copyButton.current?.focus();
              }}
            />
          ) : null}

          {view.confirmingUnsave ? (
            <p className={styles.confirm} role="group" aria-label="Confirm removal">
              Remove this learning item and its note?{" "}
              <button type="button" className={styles.link} onClick={actions.cancelUnsave}>
                Cancel
              </button>{" "}
              <button
                type="button"
                className={styles.link}
                autoFocus
                onClick={() => actions.confirmUnsave(segment)}
              >
                Remove
              </button>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
