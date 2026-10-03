import { useState } from "react";
import type { LearningItem } from "@pebble/schema";
import { Icon } from "../../components/Icon.tsx";
import { downloadText } from "../../lib/downloadText.ts";
import { useTranslationProvider } from "../translation/TranslationContext.tsx";
import {
  ANKI_BACK_TEMPLATE,
  ANKI_CSV_TYPE,
  ANKI_NOTE_TYPE,
  ankiCsvFilename,
  toAnkiCsv,
} from "./ankiCsv.ts";
import { fillTranslations } from "./fillTranslations.ts";
import { useLearning } from "./LearningContext.tsx";
import styles from "./AnkiExportPanel.module.css";

type ExportState =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "downloaded"; missingEdited: number; missingUnavailable: number }
  | { kind: "failed" };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Export button plus the Anki setup guidance a learner needs to see their translations. */
export function AnkiExportPanel({ items }: { items: readonly LearningItem[] }) {
  const translations = useTranslationProvider();
  const { saveItem } = useLearning();
  const [state, setState] = useState<ExportState>({ kind: "idle" });

  const exportCsv = async () => {
    setState({ kind: "preparing" });
    try {
      // English is included automatically: missing translations are resolved now, on export.
      const result = await fillTranslations(items, translations);
      for (const item of result.filled) saveItem(item);
      downloadText(ankiCsvFilename(), toAnkiCsv(result.items), ANKI_CSV_TYPE);
      setState({
        kind: "downloaded",
        missingEdited: result.missingEdited,
        missingUnavailable: result.missingUnavailable,
      });
    } catch (error) {
      console.warn("Pebble: CSV export failed.", error);
      setState({ kind: "failed" });
    }
  };

  return (
    <section className={styles.panel} aria-labelledby="anki-export-heading">
      <h2 id="anki-export-heading" className={styles.heading}>
        Export to Anki
      </h2>
      <button
        type="button"
        className={styles.export}
        disabled={items.length === 0 || state.kind === "preparing"}
        aria-busy={state.kind === "preparing" || undefined}
        onClick={() => void exportCsv()}
      >
        <Icon name="download" size={18} />
        Export CSV for Anki
      </button>

      <div className={styles.status} role="status">
        {state.kind === "preparing" ? (
          <p className={styles.oneTime}>Adding English translations…</p>
        ) : null}
        {state.kind === "downloaded" ? (
          <>
            <p className={styles.success}>✓ CSV downloaded successfully.</p>
            {state.missingEdited > 0 ? (
              <p className={styles.oneTime}>
                {plural(state.missingEdited, "edited line")} exported without English. Prepared
                translations only match the original transcript text.
              </p>
            ) : null}
            {state.missingUnavailable > 0 ? (
              <p className={styles.oneTime}>
                {plural(state.missingUnavailable, "item")} exported without English because the
                translation couldn’t be loaded. Export again to retry.
              </p>
            ) : null}
            <p className={styles.oneTime}>
              Anki card template setup is a one-time step. See “How to import into Anki” below.
            </p>
          </>
        ) : null}
        {state.kind === "failed" ? (
          <p className={styles.error}>Couldn’t create the CSV file. Try again.</p>
        ) : null}
      </div>

      <p className={styles.instruction}>
        In Anki, import this file using a note type with fields for Chinese, Pinyin, Translation,
        Note, and Source. Map Pebble’s Translation column to the Translation field, then ensure{" "}
        <code>{"{{Translation}}"}</code> appears in the card’s Back Template.
      </p>

      <details className={styles.help}>
        <summary>How to import into Anki</summary>
        <h3>One-time setup</h3>
        <ol>
          <li>
            In Anki, open <strong>Tools → Manage Note Types → Add</strong>, choose{" "}
            <strong>Add: Basic</strong>, and name it <strong>{ANKI_NOTE_TYPE}</strong>.
          </li>
          <li>
            Select it and click <strong>Fields…</strong>. Rename <em>Front</em> to{" "}
            <strong>Chinese</strong> and <em>Back</em> to <strong>Pinyin</strong>, then add{" "}
            <strong>Translation</strong>, <strong>Note</strong> and <strong>Source</strong>.
          </li>
          <li>
            Click <strong>Cards…</strong> and replace the <strong>Back Template</strong> with:
            <pre className={styles.code}>
              <code>{ANKI_BACK_TEMPLATE}</code>
            </pre>
          </li>
        </ol>
        <h3>Each import</h3>
        <ol start={4}>
          <li>
            <strong>File → Import</strong>, choose the CSV, and set the note type to{" "}
            <strong>{ANKI_NOTE_TYPE}</strong>.
          </li>
          <li>
            Check the field mapping: Chinese → Chinese, Pinyin → Pinyin, Translation → Translation,
            Note → Note, Source → Source, Tags → Tags. Then click <strong>Import</strong>.
          </li>
        </ol>
        <p className={styles.aside}>
          The column names in the file label the columns. They don’t create fields in Anki.
        </p>
      </details>
    </section>
  );
}
