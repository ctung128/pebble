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
import { fillPinyin } from "./fillPinyin.ts";
import { fillTranslations } from "./fillTranslations.ts";
import { useLearning } from "./LearningContext.tsx";
import styles from "./AnkiExportPanel.module.css";

type ExportState =
  | { kind: "idle" }
  | { kind: "preparing" }
  | {
      kind: "downloaded";
      missingEdited: number;
      missingUnavailable: number;
      pinyinFailed: boolean;
    }
  | { kind: "failed" };

/** The one place the page says where learning items live (they stay in this browser). */
export const KEEP_A_COPY = "Export a copy if you want to keep your cards outside this browser.";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Export button plus the Anki setup guidance a learner needs to see their translations. */
export function AnkiExportPanel({ items }: { items: readonly LearningItem[] }) {
  const translations = useTranslationProvider();
  const { saveItem } = useLearning();
  const [state, setState] = useState<ExportState>({ kind: "idle" });

  const exportCsv = async () => {
    setState({ kind: "preparing" });
    try {
      // English and pinyin are included automatically: anything missing is filled in now, on
      // export, and kept on the learning items.
      const english = await fillTranslations(items, translations);
      const pinyin = await fillPinyin(english.items);
      const changed = new Set([...english.filled, ...pinyin.filled].map((item) => item.id));
      for (const item of pinyin.items) if (changed.has(item.id)) saveItem(item);
      downloadText(ankiCsvFilename(), toAnkiCsv(pinyin.items), ANKI_CSV_TYPE);
      setState({
        kind: "downloaded",
        missingEdited: english.missingEdited,
        missingUnavailable: english.missingUnavailable,
        pinyinFailed: pinyin.failed,
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
          <p className={styles.oneTime}>Adding English and pinyin…</p>
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
            {state.pinyinFailed ? (
              <p className={styles.oneTime}>
                Pinyin couldn’t be generated, so it was left blank. Export again to retry.
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

      <details className={styles.help}>
        <summary>How to import into Anki</summary>
        <p className={styles.aside}>{KEEP_A_COPY}</p>
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
