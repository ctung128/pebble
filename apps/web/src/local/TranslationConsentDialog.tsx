import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { CONSENT_BODY, CONSENT_CANCEL, CONSENT_CONFIRM, CONSENT_TITLE } from "./translationCopy.ts";
import styles from "./TranslationConsentDialog.module.css";

interface TranslationConsentDialogProps {
  busy: boolean;
  /** A fixed message after a failed grant; the dialog stays open. */
  problem: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The short consent dialog (docs/TRANSLATION.md#consent): exact copy, no expandable details.
 * Opening it grants nothing; only Translate does. Focus starts on Cancel, Escape cancels, Tab
 * stays inside, and focus returns to where it was when the dialog closes.
 */
export function TranslationConsentDialog({
  busy,
  problem,
  onConfirm,
  onCancel,
}: TranslationConsentDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const problemId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onCancel();
      return;
    }
    // Player shortcuts (Space, R, arrows, P, T, S) stay off while the dialog is open.
    event.stopPropagation();
    if (event.key !== "Tab") return;
    const buttons = Array.from(dialog.current?.querySelectorAll("button") ?? []);
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <div className={styles.backdrop}>
      <div
        ref={dialog}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={problem ? `${bodyId} ${problemId}` : bodyId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className={styles.title}>
          {CONSENT_TITLE}
        </h2>
        <p id={bodyId} className={styles.body}>
          {CONSENT_BODY}
        </p>
        {problem ? (
          <p id={problemId} className={styles.problem} role="alert">
            {problem}
          </p>
        ) : null}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.confirm}
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
            onClick={() => {
              if (!busy) onConfirm();
            }}
          >
            {CONSENT_CONFIRM}
          </button>
          <button
            ref={cancel}
            type="button"
            className={styles.cancel}
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) onCancel();
            }}
          >
            {CONSENT_CANCEL}
          </button>
        </div>
      </div>
    </div>
  );
}
