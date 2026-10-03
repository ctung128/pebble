import { useId, useState } from "react";
import type { CorrectionResult } from "../learning/LearningContext.tsx";
import styles from "./CorrectionEditor.module.css";

interface CorrectionEditorProps {
  initialText: string;
  language: string;
  onSave: (text: string) => CorrectionResult;
  onCancel: () => void;
}

/** Edits a whole transcript line. Esc cancels; ⌘/Ctrl+Enter saves. */
export function CorrectionEditor({
  initialText,
  language,
  onSave,
  onCancel,
}: CorrectionEditorProps) {
  const id = useId();
  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (onSave(text) === "empty") setError("A line can't be empty.");
  };

  return (
    <form
      className={styles.editor}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor={id} className={styles.label}>
        Edit this line
      </label>
      <textarea
        id={id}
        className={styles.input}
        lang={language}
        rows={2}
        value={text}
        autoFocus
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {error ? (
        <p id={`${id}-error`} className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.buttons}>
        <button type="submit" className={styles.primary}>
          Save edit
        </button>
        <button type="button" className={styles.secondary} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
