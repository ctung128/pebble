import { useState, type ReactNode } from "react";
import styles from "./ConfirmButton.module.css";

interface ConfirmButtonProps {
  children: ReactNode;
  /** Question shown while confirming, e.g. "Delete this item?" */
  prompt: string;
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
  /** Skip the confirmation step (e.g. when there's nothing to lose). */
  skipConfirm?: boolean;
  "aria-label"?: string;
}

/** A two-step inline confirmation for destructive actions; no modal or browser dialog. */
export function ConfirmButton({
  children,
  prompt,
  confirmLabel,
  onConfirm,
  className,
  skipConfirm = false,
  "aria-label": ariaLabel,
}: ConfirmButtonProps) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        className={className}
        aria-label={ariaLabel}
        onClick={() => (skipConfirm ? onConfirm() : setConfirming(true))}
      >
        {children}
      </button>
    );
  }

  return (
    <span
      className={styles.confirm}
      role="group"
      aria-label={prompt}
      onKeyDown={(event) => event.key === "Escape" && setConfirming(false)}
    >
      <span className={styles.prompt}>{prompt}</span>
      <button type="button" className={styles.cancel} onClick={() => setConfirming(false)}>
        Cancel
      </button>
      <button
        type="button"
        className={styles.danger}
        autoFocus
        onClick={() => {
          setConfirming(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
    </span>
  );
}
