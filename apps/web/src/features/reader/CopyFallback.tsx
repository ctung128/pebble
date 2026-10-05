import { useEffect, useRef } from "react";
import { COPY_FAILED } from "./copyText.ts";
import styles from "./CopyFallback.module.css";

/** Shown when the clipboard refuses: the line, selected, ready for ⌘C / Ctrl+C. */
export function CopyFallback({
  text,
  language,
  onClose,
}: {
  text: string;
  language: string;
  onClose: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  return (
    <div className={styles.copyFallback}>
      <p aria-live="polite">{COPY_FAILED}</p>
      <div className={styles.copyFallbackRow}>
        <input
          ref={field}
          className={styles.copyField}
          readOnly
          value={text}
          lang={language}
          aria-label="Chinese text for this line"
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
          }}
        />
        <button type="button" className={styles.close} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
