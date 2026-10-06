import { useCallback } from "react";
import { PageHeader } from "../../components/PageHeader.tsx";
import { StatusView } from "../../components/StatusView.tsx";
import { describeSourceError } from "../../data/EpisodeSource.ts";
import { useEpisodeSource } from "../../data/SourceContext.tsx";
import { formatTime } from "../../lib/formatTime.ts";
import { useAsync } from "../../lib/useAsync.ts";
import { EpisodeRow, rowStyles } from "./EpisodeRow.tsx";
import styles from "./LibraryPage.module.css";

export function LibraryPage() {
  const source = useEpisodeSource();
  const load = useCallback(() => source.listEpisodes(), [source]);
  const state = useAsync(load);
  const count = state.status === "success" ? state.data.length : null;

  return (
    <div className={styles.page}>
      <PageHeader
        title="Library"
        vertical="书架"
        meta={count === null ? null : `${count} ${count === 1 ? "episode" : "episodes"}`}
      >
        <p className={styles.lede}>
          Listen to Chinese podcasts with a timed transcript, pinyin, and English translation. This
          demo uses sample episodes; the full version runs locally with your own audio.
        </p>
      </PageHeader>

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
        <ol className={rowStyles.list} aria-label="Episodes">
          {state.data.map((episode, i) => (
            <EpisodeRow
              key={episode.id}
              number={i + 1}
              title={episode.title}
              titleZh={episode.titleZh}
              language={episode.language}
              href={`/episodes/${episode.id}`}
              meta={
                <>
                  <span className={rowStyles.metaItem}>{formatTime(episode.durationMs)}</span>
                  {!episode.audioProvenance.publishable ? (
                    <span className={rowStyles.warningTag}>Placeholder audio</span>
                  ) : null}
                </>
              }
            />
          ))}
        </ol>
      ) : null}
    </div>
  );
}
