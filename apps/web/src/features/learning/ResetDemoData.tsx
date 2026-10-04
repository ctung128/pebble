import { useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton.tsx";
import { useLearning } from "./LearningContext.tsx";
import styles from "./ResetDemoData.module.css";

/** Local mode holds real study data, so the control says exactly that (never "demo"). */
export const resetCopy = () =>
  __PEBBLE_LOCAL__
    ? {
        button: "Remove all edits and learning items",
        done: "Your edits and learning items were removed from this browser.",
      }
    : {
        button: "Reset demo data",
        done: "Demo data reset. Transcripts are back to their original text.",
      };

/** Clears learner data in this browser. Episodes and transcripts are never affected. */
export function ResetDemoData() {
  const { resetAll } = useLearning();
  const [done, setDone] = useState(false);
  const copy = resetCopy();

  return (
    <div className={styles.reset}>
      <ConfirmButton
        className={styles.button}
        prompt="Remove your edits and learning items from this browser?"
        confirmLabel="Reset"
        onConfirm={() => {
          resetAll();
          setDone(true);
        }}
      >
        {copy.button}
      </ConfirmButton>
      <p className={styles.status} role="status">
        {done ? copy.done : ""}
      </p>
    </div>
  );
}
