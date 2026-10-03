import { useId, useState } from "react";
import { Link } from "react-router";
import type { LearningItem } from "@pebble/schema";
import { ConfirmButton } from "../../components/ConfirmButton.tsx";
import { StatusView } from "../../components/StatusView.tsx";
import { itemSource } from "./ankiCsv.ts";
import { AnkiExportPanel } from "./AnkiExportPanel.tsx";
import { useLearning } from "./LearningContext.tsx";
import { ResetDemoData } from "./ResetDemoData.tsx";
import styles from "./LearningItemsPage.module.css";

export function LearningItemsPage() {
  const { items, persistence } = useLearning();

  return (
    <div className={styles.page}>
      <title>Learning items · Pebble</title>
      <header className={styles.header}>
        <div>
          <h1 className={styles.heading}>Learning items</h1>
          <p className={styles.lede}>
            Lines you saved while listening. Export them to Anki as CSV.
          </p>
        </div>
      </header>

      <AnkiExportPanel items={items} />

      {persistence.mode === "loading" ? (
        <StatusView kind="loading" title="Loading learning items…" />
      ) : items.length === 0 ? (
        <StatusView
          kind="empty"
          title="No learning items yet"
          message="Save a line from any transcript (the bookmark button, or S) and it will appear here."
        />
      ) : (
        <ul className={styles.list}>
          {items.map((item) => (
            <ItemCard key={item.id} item={item} />
          ))}
        </ul>
      )}

      <ResetDemoData />
    </div>
  );
}

function ItemCard({ item }: { item: LearningItem }) {
  const { updateNote, removeItem } = useLearning();
  const noteId = useId();
  const [note, setNote] = useState(item.note ?? "");
  const [savedNote, setSavedNote] = useState(false);
  const dirty = note !== (item.note ?? "");

  return (
    <li className={styles.card}>
      <p className={styles.text} lang="zh-CN">
        {item.text}
      </p>
      {item.pinyin ? (
        <p className={styles.pinyin} lang="zh-Latn-pinyin">
          {item.pinyin}
        </p>
      ) : null}
      {item.translation ? (
        <p className={styles.translation} lang="en">
          {item.translation}
        </p>
      ) : null}
      {item.originalText ? (
        <p className={styles.original}>
          Edited by you · original: <span lang="zh-CN">{item.originalText}</span>
        </p>
      ) : null}

      <p className={styles.source}>
        <Link to={`/episodes/${item.episodeId}?segment=${encodeURIComponent(item.segmentId)}`}>
          {itemSource(item)}
        </Link>
      </p>

      <form
        className={styles.noteForm}
        onSubmit={(event) => {
          event.preventDefault();
          updateNote(item.id, note);
          setSavedNote(true);
        }}
      >
        <label htmlFor={noteId} className={styles.noteLabel}>
          Note
        </label>
        <textarea
          id={noteId}
          className={styles.note}
          rows={2}
          value={note}
          placeholder="Optional — a reminder, a word to look up, context…"
          onChange={(event) => {
            setNote(event.target.value);
            setSavedNote(false);
          }}
        />
        <div className={styles.cardActions}>
          <button type="submit" className={styles.secondary} disabled={!dirty}>
            Save note
          </button>
          <span className={styles.saved} role="status">
            {savedNote && !dirty ? "Note saved" : ""}
          </span>
          <ConfirmButton
            className={styles.delete}
            prompt="Delete this learning item?"
            confirmLabel="Delete"
            onConfirm={() => removeItem(item.id)}
          >
            Delete
          </ConfirmButton>
        </div>
      </form>
    </li>
  );
}
