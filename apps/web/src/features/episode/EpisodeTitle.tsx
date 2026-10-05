import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Icon } from "../../components/Icon.tsx";
import { episodeTitleProblem } from "./episodeRename.ts";
import styles from "./EpisodeTitle.module.css";

interface EpisodeTitleProps {
  title: string;
  /** The h1's own class (size and spacing differ by page). */
  className?: string;
  /** When set, a quiet pencil button renames the episode; rejects with a learner-safe message. */
  onRename?: ((title: string) => Promise<void>) | undefined;
}

/**
 * An episode's title, with an optional inline rename: the current title prefilled, Enter to
 * save, Escape or Cancel to leave it as it was, and focus back on the pencil afterwards.
 */
export function EpisodeTitle({ title, className, onRename }: EpisodeTitleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pencil = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const wasEditing = useRef(false);
  const fieldId = useId();
  const problemId = useId();

  useEffect(() => {
    if (editing) {
      field.current?.focus();
      field.current?.select();
    } else if (wasEditing.current) {
      pencil.current?.focus();
    }
    wasEditing.current = editing;
  }, [editing]);

  const close = () => {
    setEditing(false);
    setProblem(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!onRename || busy) return;
    const found = episodeTitleProblem(draft);
    if (found) {
      setProblem(found);
      return;
    }
    const next = draft.trim();
    if (next === title) {
      close(); // unchanged: nothing to save
      return;
    }
    setBusy(true);
    try {
      await onRename(next);
      close();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Couldn't rename. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <form className={styles.form} onSubmit={(event) => void save(event)} noValidate>
        {/* The page keeps its heading while the title is being edited. */}
        <h1 className={styles.visuallyHidden}>{title}</h1>
        <label htmlFor={fieldId} className={styles.label}>
          Episode title
        </label>
        <input
          ref={field}
          id={fieldId}
          className={styles.field}
          value={draft}
          disabled={busy}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? problemId : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setProblem(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
        />
        {problem ? (
          <p id={problemId} className={styles.problem} role="alert">
            {problem}
          </p>
        ) : null}
        <div className={styles.actions}>
          <button
            type="submit"
            className={styles.save}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            Save
          </button>
          <button type="button" className={styles.cancel} disabled={busy} onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className={styles.line}>
      <h1 className={className}>{title}</h1>
      {onRename ? (
        <button
          ref={pencil}
          type="button"
          className={styles.pencil}
          aria-label="Rename episode"
          title="Rename episode"
          onClick={() => {
            setDraft(title);
            setEditing(true);
          }}
        >
          <Icon name="edit" size={18} />
        </button>
      ) : null}
    </div>
  );
}
