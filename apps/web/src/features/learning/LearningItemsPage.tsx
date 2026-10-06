import { useCallback, useId, useMemo, useState } from "react";
import { Link } from "react-router";
import type { LearningItem } from "@pebble/schema";
import { ConfirmButton } from "../../components/ConfirmButton.tsx";
import { Icon } from "../../components/Icon.tsx";
import { PageHeader } from "../../components/PageHeader.tsx";
import { SearchField } from "../../components/SearchField.tsx";
import { StatusView } from "../../components/StatusView.tsx";
import { useEpisodeSource } from "../../data/SourceContext.tsx";
import { useAsync } from "../../lib/useAsync.ts";
import { foldForSearch, matchesQuery } from "../../lib/search.ts";
import { useDebouncedAnnouncement } from "../../lib/useDebouncedAnnouncement.ts";
import { itemSource } from "./ankiCsv.ts";
import { AnkiExportPanel } from "./AnkiExportPanel.tsx";
import { EmptyLearningItems } from "./EmptyLearningItems.tsx";
import { useLearning } from "./LearningContext.tsx";
import styles from "./LearningItemsPage.module.css";

interface EpisodeGroup {
  episodeId: string;
  title: string;
  items: LearningItem[];
}

/** Items grouped by episode, in the order their first item appears. */
function groupByEpisode(items: readonly LearningItem[]): EpisodeGroup[] {
  const groups = new Map<string, EpisodeGroup>();
  for (const item of items) {
    const group = groups.get(item.episodeId);
    if (group) group.items.push(item);
    else
      groups.set(item.episodeId, {
        episodeId: item.episodeId,
        title: item.episodeTitle,
        items: [item],
      });
  }
  return [...groups.values()];
}

/**
 * Whether an item matches a search, using only what the item itself stores: its Chinese (and
 * original text, if edited), pinyin, English, note and the episode title saved with it.
 * Accents and tone marks are ignored, so "tian" finds "tiān". Never anything else about the
 * episode, deleted or not.
 */
function itemMatches(item: LearningItem, query: string): boolean {
  return [item.text, item.originalText, item.pinyin, item.translation, item.note, item.episodeTitle]
    .filter((field): field is string => typeof field === "string")
    .some((field) => matchesQuery(field, query, foldForSearch));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function LearningItemsPage() {
  const { items, persistence } = useLearning();
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const found = useMemo(
    () => (searching ? items.filter((item) => itemMatches(item, query)) : items),
    [items, query, searching],
  );
  // Groups with no matches disappear with their items.
  const groups = useMemo(() => groupByEpisode(found), [found]);
  const resultCount = useDebouncedAnnouncement(
    searching ? `${found.length} of ${plural(items.length, "item")}` : "",
  );
  const chineseTitles = useChineseTitles();

  return (
    <div className={styles.page}>
      <title>Learning items · Pebble</title>
      <PageHeader
        title="Learning items"
        vertical="学习条目"
        meta={
          persistence.mode === "loading"
            ? null
            : searching
              ? `${found.length} of ${plural(items.length, "item")}`
              : plural(items.length, "item")
        }
      />

      <div className={styles.columns}>
        <div className={styles.main}>
          {persistence.mode === "loading" ? (
            <StatusView kind="loading" title="Loading learning items…" />
          ) : items.length === 0 ? (
            <EmptyLearningItems />
          ) : (
            <>
              <SearchField
                label="Search learning items"
                placeholder="Search Chinese, pinyin, English or notes"
                value={query}
                onChange={setQuery}
              />
              <p className={styles.visuallyHidden} role="status" aria-live="polite">
                {resultCount}
              </p>
              {found.length === 0 ? (
                <div className={styles.noResults}>
                  <p className={styles.noResultsTitle}>No learning items match “{query.trim()}”.</p>
                  <button type="button" className={styles.secondary} onClick={() => setQuery("")}>
                    Clear search
                  </button>
                </div>
              ) : null}
              {groups.map((group) => (
                <section
                  key={group.episodeId}
                  className={styles.group}
                  aria-labelledby={`group-${group.episodeId}`}
                >
                  <div className={styles.groupHeading}>
                    <h2 id={`group-${group.episodeId}`} className={styles.groupTitle}>
                      {group.title}
                      {chineseTitles.get(group.episodeId) ? (
                        <span className={styles.groupTitleZh} lang="zh-CN">
                          {chineseTitles.get(group.episodeId)}
                        </span>
                      ) : null}
                    </h2>
                    <span className={styles.groupCount}>{plural(group.items.length, "item")}</span>
                  </div>
                  <ul className={styles.list}>
                    {group.items.map((item) => (
                      <ItemCard key={item.id} item={item} />
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )}
        </div>

        <aside className={styles.side} aria-label="Export and data">
          <AnkiExportPanel items={items} />
        </aside>
      </div>
    </div>
  );
}

/**
 * Chinese episode titles for the group headings, when the source has them. Optional: if the
 * list can't load, headings just show the English title (saved on each item).
 */
function useChineseTitles(): ReadonlyMap<string, string> {
  const source = useEpisodeSource();
  const load = useCallback(() => source.listEpisodes(), [source]);
  const state = useAsync(load);
  return useMemo(() => {
    const titles = new Map<string, string>();
    if (state.status === "success") {
      for (const episode of state.data)
        if (episode.titleZh) titles.set(episode.id, episode.titleZh);
    }
    return titles;
  }, [state]);
}

function ItemCard({ item }: { item: LearningItem }) {
  const { updateNote, removeItem } = useLearning();
  const noteId = useId();
  const formId = useId();
  const [note, setNote] = useState(item.note ?? "");
  const [savedNote, setSavedNote] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const dirty = note !== (item.note ?? "");
  const lineHref = `/episodes/${item.episodeId}?segment=${encodeURIComponent(item.segmentId)}`;

  return (
    <li className={styles.card}>
      <div className={styles.tools}>
        <button
          type="button"
          className={styles.tool}
          aria-label="Edit note"
          title="Edit note"
          aria-expanded={editingNote}
          aria-controls={editingNote ? formId : undefined}
          onClick={() => setEditingNote((open) => !open)}
        >
          <Icon name="edit" size={18} />
        </button>
      </div>

      <div className={styles.body}>
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
      </div>

      {editingNote ? (
        <form
          id={formId}
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
            className={styles.noteField}
            rows={2}
            value={note}
            autoFocus
            placeholder="Optional — a reminder, a word to look up, context…"
            onChange={(event) => {
              setNote(event.target.value);
              setSavedNote(false);
            }}
          />
          <div className={styles.noteActions}>
            <button type="submit" className={styles.secondary} disabled={!dirty}>
              Save note
            </button>
            <span className={styles.saved} role="status">
              {savedNote && !dirty ? "Note saved" : ""}
            </span>
          </div>
        </form>
      ) : item.note ? (
        <p className={styles.note}>
          <span className={styles.noteLabel}>Note</span> {item.note}
        </p>
      ) : null}

      <div className={styles.footer}>
        {item.sourceDeletedAt ? (
          <>
            <span className={styles.tag}>Source deleted</span>
            <span className={styles.source}>{itemSource(item)}</span>
          </>
        ) : (
          <Link to={lineHref} className={styles.sourceLink}>
            {itemSource(item)}
          </Link>
        )}
        {item.originalText ? (
          <span className={styles.original}>
            <span className={styles.tag}>Edited by you</span> original:{" "}
            <span lang="zh-CN">{item.originalText}</span>
          </span>
        ) : null}
        {/* Destructive, so apart from the reading tools; confirmed inline. */}
        <span className={styles.deleteSlot}>
          <ConfirmButton
            className={styles.delete}
            prompt="Delete this learning item?"
            confirmLabel="Delete"
            onConfirm={() => removeItem(item.id)}
          >
            Delete
          </ConfirmButton>
        </span>
      </div>
    </li>
  );
}
