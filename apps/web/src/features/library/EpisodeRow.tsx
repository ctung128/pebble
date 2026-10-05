import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";
import styles from "./EpisodeRow.module.css";

/**
 * Covers are hidden for now (there are no cover images yet). The markup and styles stay:
 * set this to true to bring the first-character covers back.
 */
export const SHOW_COVERS = false;

interface EpisodeRowProps {
  /** 1-based position in the list (shown as "01"; the list itself conveys order). */
  number: number;
  title: string;
  titleZh?: string | undefined;
  language?: string | undefined;
  /** Facts under the titles: duration, date, tags. */
  meta?: ReactNode;
  /** When set, the title links here and the whole row is clickable. */
  href?: string | undefined;
  status?: ReactNode;
  /** Right-aligned actions. A confirmation inside them takes the row's full width. */
  actions?: ReactNode;
  /** Full-width content under the row, e.g. an error from an action. */
  footer?: ReactNode;
}

/**
 * One episode in the Library (design system EpisodeRow): number, cover, titles, status, action.
 * There are no cover images, so the cover is the title's first character on rice paper.
 */
export function EpisodeRow({
  number,
  title,
  titleZh,
  language,
  meta,
  href,
  status,
  actions,
  footer,
}: EpisodeRowProps) {
  const coverText = titleZh || title;
  const cover = Array.from(coverText)[0] ?? "";
  return (
    <li
      className={styles.row}
      data-linked={href ? true : undefined}
      data-cover={SHOW_COVERS || undefined}
    >
      <span className={styles.number} aria-hidden="true">
        {String(number).padStart(2, "0")}
      </span>
      {SHOW_COVERS ? (
        <span className={styles.cover} aria-hidden="true" lang={titleZh ? language : undefined}>
          {cover}
        </span>
      ) : null}
      <div className={styles.titles}>
        {href ? (
          <Link to={href} className={`${styles.title} ${styles.titleLink}`}>
            {title}
          </Link>
        ) : (
          <p className={styles.title}>{title}</p>
        )}
        {titleZh || meta ? (
          <p className={styles.sub}>
            {titleZh ? (
              <span className={styles.titleZh} lang={language}>
                {titleZh}
              </span>
            ) : null}
            {meta}
          </p>
        ) : null}
      </div>
      <div className={styles.status}>{status}</div>
      <div className={styles.actions}>{actions}</div>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </li>
  );
}

/**
 * A status line with an optional bar. `fraction` is a real completed/total ratio; null draws
 * an indeterminate bar (nothing is known yet), undefined draws no bar.
 */
export function RowProgress({
  label,
  fraction,
}: {
  label: ReactNode;
  fraction?: number | null | undefined;
}) {
  return (
    <>
      <span className={styles.statusLabel}>{label}</span>
      {fraction === undefined ? null : (
        <span
          className={styles.bar}
          data-indeterminate={fraction === null || undefined}
          style={
            fraction === null
              ? undefined
              : ({ "--progress": `${Math.round(fraction * 100)}%` } as CSSProperties)
          }
          aria-hidden="true"
        >
          <span />
        </span>
      )}
    </>
  );
}

/** Class names for row-level controls, shared by the demo and local libraries. */
export const rowStyles = {
  list: styles.list,
  action: styles.action,
  delete: styles.delete,
  tag: styles.tag,
  warningTag: styles.warningTag,
  failure: styles.failure,
  fieldError: styles.fieldError,
  metaItem: styles.metaItem,
};
