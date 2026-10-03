import { useState } from "react";
import { useLearning } from "../features/learning/LearningContext.tsx";
import styles from "./StorageNotice.module.css";

/** Non-blocking notice shown when learner data can't be saved in this browser. */
export function StorageNotice() {
  const { persistence } = useLearning();
  const [dismissed, setDismissed] = useState(false);
  if (persistence.mode !== "session" || dismissed) return null;

  return (
    <div className={styles.notice} role="status">
      <p>
        {persistence.reason === "write-failed"
          ? "Pebble couldn't save your last change in this browser."
          : "This browser isn't letting Pebble save data."}{" "}
        You can keep using Pebble, but edits and learning items will only last until you close this
        tab.
      </p>
      <button type="button" className={styles.dismiss} onClick={() => setDismissed(true)}>
        Dismiss
      </button>
    </div>
  );
}
