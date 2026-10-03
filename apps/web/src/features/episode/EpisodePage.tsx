import { useCallback, useEffect, useMemo, useRef } from "react";
import { Link } from "react-router";
import type { Segment, Transcript } from "@pebble/schema";
import { Icon } from "../../components/Icon.tsx";
import { StatusView } from "../../components/StatusView.tsx";
import { describeSourceError, type ResolvedEpisode } from "../../data/EpisodeSource.ts";
import { useEpisodeSource } from "../../data/SourceContext.tsx";
import { formatTime } from "../../lib/formatTime.ts";
import { useAsync } from "../../lib/useAsync.ts";
import { PlayerBar } from "../player/PlayerBar.tsx";
import { useAudioPlayer } from "../player/useAudioPlayer.ts";
import { findActiveSegmentIndex } from "../reader/activeSegment.ts";
import { TranscriptReader } from "../reader/TranscriptReader.tsx";
import { useFollowActive } from "../reader/useFollowActive.ts";
import { resolvePlayerKey } from "./playerKeys.ts";
import styles from "./EpisodePage.module.css";

export function EpisodePage({ episodeId }: { episodeId: string }) {
  const source = useEpisodeSource();
  const load = useCallback(
    () => Promise.all([source.getEpisode(episodeId), source.getTranscript(episodeId)]),
    [source, episodeId],
  );
  const state = useAsync(load);

  if (state.status === "loading") return <StatusView kind="loading" title="Loading episode…" />;
  if (state.status === "error") {
    const { title, detail } = describeSourceError(state.error);
    return (
      <div className={styles.page}>
        <BackLink />
        <StatusView kind="error" title={title} message={detail} onRetry={state.retry} />
      </div>
    );
  }
  const [episode, transcript] = state.data;
  return <EpisodeView episode={episode} transcript={transcript} />;
}

function BackLink() {
  return (
    <Link to="/" className={styles.back}>
      <Icon name="back" size={18} />
      Library
    </Link>
  );
}

function EpisodeView({
  episode,
  transcript,
}: {
  episode: ResolvedEpisode;
  transcript: Transcript;
}) {
  const { segments } = transcript;
  const [audioRef, player] = useAudioPlayer(episode.durationMs);
  const { seek, toggle } = player;
  const activeIndex = findActiveSegmentIndex(segments, player.currentTimeMs);
  const readerRef = useRef<HTMLOListElement>(null);
  const { isFollowing, resume } = useFollowActive(readerRef, activeIndex);

  const playSegment = useCallback(
    (segment: Segment) => {
      resume();
      seek(segment.startMs, { play: true });
    },
    [resume, seek],
  );

  const goToIndex = useCallback(
    (index: number) => {
      const segment = segments[Math.min(Math.max(index, 0), segments.length - 1)];
      if (!segment) return;
      resume();
      // Stepping keeps the current play/pause state; replay and line clicks always play.
      seek(segment.startMs);
    },
    [segments, resume, seek],
  );

  const replay = useCallback(() => {
    const segment = segments[Math.max(activeIndex, 0)];
    if (segment) playSegment(segment);
  }, [segments, activeIndex, playSegment]);
  const previous = useCallback(() => goToIndex(activeIndex - 1), [goToIndex, activeIndex]);
  const next = useCallback(() => goToIndex(activeIndex + 1), [goToIndex, activeIndex]);

  useEffect(() => {
    const actions = { toggle, replay, previous, next };
    const onKeyDown = (event: KeyboardEvent) => {
      const action = resolvePlayerKey(event);
      if (!action) return;
      event.preventDefault(); // stops Space from scrolling or activating a focused button
      if (!event.repeat || action !== "toggle") actions[action]();
    };
    // A focused button activates on Space keyup, so that default is cancelled too.
    const onKeyUp = (event: KeyboardEvent) => {
      if (resolvePlayerKey(event) === "toggle") event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [toggle, replay, previous, next]);

  const isPlaceholderAudio = episode.audioProvenance.kind === "tts-placeholder";
  const isAuthoredTranscript = transcript.provenance.kind === "fixture";
  const lineCount = useMemo(
    () => `${segments.length} ${segments.length === 1 ? "line" : "lines"}`,
    [segments],
  );

  return (
    <article className={styles.page}>
      <title>{`${episode.title} · Pebble`}</title>
      <BackLink />

      <header className={styles.header}>
        <h1 className={styles.title}>{episode.title}</h1>
        {episode.titleZh ? (
          <p className={styles.titleZh} lang={transcript.language}>
            {episode.titleZh}
          </p>
        ) : null}
        <p className={styles.description}>{episode.description}</p>
        <p className={styles.meta}>
          {formatTime(episode.durationMs)} · {lineCount}
        </p>
      </header>

      {isPlaceholderAudio || isAuthoredTranscript ? (
        <aside className={styles.notice} aria-label="About this sample">
          {isPlaceholderAudio ? (
            <p>
              <strong>Development placeholder.</strong> The audio is a synthetic voice reading an
              original script. It is not a real podcast.
            </p>
          ) : null}
          {isAuthoredTranscript ? (
            <p>
              The transcript is the authored script with measured timings, not speech-recognition
              output, so it doesn't reflect transcription accuracy.
            </p>
          ) : null}
        </aside>
      ) : null}

      <section aria-labelledby="transcript-heading">
        <div className={styles.sectionHead}>
          <h2 id="transcript-heading" className={styles.sectionTitle}>
            Transcript
          </h2>
          <p className={styles.keys} aria-label="Keyboard shortcuts">
            <kbd>Space</kbd> play/pause · <kbd>R</kbd> replay line · <kbd>←</kbd>
            <kbd>→</kbd> previous/next line
          </p>
        </div>
        <TranscriptReader
          ref={readerRef}
          segments={segments}
          activeIndex={activeIndex}
          language={transcript.language}
          onSelectSegment={playSegment}
        />
      </section>

      {!isFollowing && activeIndex >= 0 ? (
        <button type="button" className={styles.resume} onClick={resume}>
          Back to current line
        </button>
      ) : null}

      <audio ref={audioRef} src={episode.audioUrl} preload="metadata" />
      <PlayerBar
        player={player}
        canGoPrevious={activeIndex > 0}
        canGoNext={activeIndex < segments.length - 1}
        onPrevious={previous}
        onReplay={replay}
        onNext={next}
      />
    </article>
  );
}
