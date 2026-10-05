import type { ReactNode } from "react";
import styles from "./PageHeader.module.css";

interface PageHeaderProps {
  /** Optional small index label, e.g. "01 — Library". */
  index?: string;
  title: string;
  /** One line of facts under the title, e.g. "3 episodes · 1 processing". */
  meta?: ReactNode;
  /** The Chinese page name, set vertically at the edge. Decorative: it repeats the title. */
  vertical: string;
  /** Lede and notes under the title. */
  children?: ReactNode;
}

/** The top of a top-level page (Library, Learning items), per the design system's PageHeader. */
export function PageHeader({ index, title, meta, vertical, children }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      {index ? <p className={styles.index}>{index}</p> : null}
      <h1 className={styles.title}>{title}</h1>
      {meta ? <p className={styles.meta}>{meta}</p> : null}
      {children}
      <span className={styles.vertical} lang="zh-CN" aria-hidden="true">
        {vertical}
      </span>
    </header>
  );
}
