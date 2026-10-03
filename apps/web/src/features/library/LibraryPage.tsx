import { useCallback } from "react";
import { Link } from "react-router";
import { StatusView } from "../../components/StatusView.tsx";
import { describeSourceError } from "../../data/EpisodeSource.ts";
import { useEpisodeSource } from "../../data/SourceContext.tsx";
import { formatTime } from "../../lib/formatTime.ts";
import { useAsync } from "../../lib/useAsync.ts";
import styles from "./LibraryPage.module.css";

export function LibraryPage() {
  const source = useEpisodeSource();
  const load = useCallback(() => source.listEpisodes(), [source]);
  const state = useAsync(load);

  return (
    <div className={styles.page}>
      <header className={styles.intro}>
        <h1 className={styles.heading}>Library</h1>
        <p className={styles.lede}>
          Listen to Mandarin audio alongside a timestamped transcript. Tap any line to hear it
          again.
        </p>
      </header>

      {state.status === "loading" ? <StatusView kind="loading" title="Loading episodes…" /> : null}

      {state.status === "error" ? (
        <StatusView
          kind="error"
          title={describeSourceError(state.error).title}
          message={describeSourceError(state.error).detail}
          onRetry={state.retry}
        />
      ) : null}

      {state.status === "success" && state.data.length === 0 ? (
        <StatusView
          kind="empty"
          title="No episodes yet"
          message="This demo doesn't include any episodes."
        />
      ) : null}

      {state.status === "success" && state.data.length > 0 ? (
        <ul className={styles.list}>
          {state.data.map((episode) => (
            <li key={episode.id}>
              <Link to={`/episodes/${episode.id}`} className={styles.card}>
                <span className={styles.cardTitle}>{episode.title}</span>
                {episode.titleZh ? (
                  <span className={styles.cardTitleZh} lang={episode.language}>
                    {episode.titleZh}
                  </span>
                ) : null}
                <span className={styles.cardDescription}>{episode.description}</span>
                <span className={styles.cardMeta}>
                  <span>{formatTime(episode.durationMs)}</span>
                  {!episode.audioProvenance.publishable ? (
                    <span className={styles.tag}>Placeholder audio</span>
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
