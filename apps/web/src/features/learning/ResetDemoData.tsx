import { useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton.tsx";
import { useLearning } from "./LearningContext.tsx";
import styles from "./ResetDemoData.module.css";

/** Clears learner data in this browser. Episodes and transcripts are never affected. */
export function ResetDemoData() {
  const { resetAll } = useLearning();
  const [done, setDone] = useState(false);

  return (
    <div className={styles.reset}>
      <p className={styles.explain}>
        Your edits and learning items are stored only in this browser.
      </p>
      <ConfirmButton
        className={styles.button}
        prompt="Remove your edits and learning items from this browser?"
        confirmLabel="Reset"
        onConfirm={() => {
          resetAll();
          setDone(true);
        }}
      >
        Reset demo data
      </ConfirmButton>
      <p className={styles.status} role="status">
        {done ? "Demo data reset. Transcripts are back to their original text." : ""}
      </p>
    </div>
  );
}
