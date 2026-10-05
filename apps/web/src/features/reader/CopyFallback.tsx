import { useEffect, useRef } from "react";
import { COPY_FAILED } from "./copyText.ts";
import styles from "./CopyFallback.module.css";

/** Shown when the clipboard refuses: the line, selected, ready for ⌘C / Ctrl+C. */
export function CopyFallback({
  text,
  language,
  onClose,
  multiline = false,
  label = "Chinese text for this line",
}: {
  text: string;
  language: string;
  onClose: () => void;
  /** A whole transcript: a read-only text area instead of a one-line field. */
  multiline?: boolean;
  label?: string;
}) {
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const fieldProps = {
    ref: field,
    className: styles.copyField,
    readOnly: true,
    value: text,
    lang: language,
    "aria-label": label,
    onFocus: (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) =>
      event.currentTarget.select(),
    onKeyDown: (event: { key: string }) => {
      if (event.key === "Escape") onClose();
    },
  };
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  return (
    <div className={styles.copyFallback}>
      <p aria-live="polite">{COPY_FAILED}</p>
      <div className={styles.copyFallbackRow}>
        {multiline ? <textarea rows={6} {...fieldProps} /> : <input {...fieldProps} />}
        <button type="button" className={styles.close} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
