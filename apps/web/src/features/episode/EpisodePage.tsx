import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Transcript } from "@pebble/schema";
import { Icon } from "../../components/Icon.tsx";
import { ShortcutSlot } from "../../components/ShellSlot.tsx";
import { StatusView } from "../../components/StatusView.tsx";
import {
  describeSourceError,
  type ResolvedEpisode,
  type ReviewHint,
} from "../../data/EpisodeSource.ts";
import { useEpisodeSource } from "../../data/SourceContext.tsx";
import { formatTime } from "../../lib/formatTime.ts";
import { useAsync } from "../../lib/useAsync.ts";
import { buildLearningItem } from "../learning/buildLearningItem.ts";
import { useLearning } from "../learning/LearningContext.tsx";
import { listeningState } from "../learning/playback.ts";
import { usePinyin } from "../pinyin/usePinyin.ts";
import { PlayerBar } from "../player/PlayerBar.tsx";
import { useAudioPlayer, type AudioPlayer } from "../player/useAudioPlayer.ts";
import { useEpisodeRename } from "./episodeRename.ts";
import { EpisodeTitle } from "./EpisodeTitle.tsx";
import { usePlaybackProgress } from "./usePlaybackProgress.ts";
import { useReplayCue } from "./useReplayCue.ts";
import { findActiveSegmentIndex } from "../reader/activeSegment.ts";
import { replayStartMs } from "../reader/replayStart.ts";
import type { LineActions, LineView } from "../reader/lineView.ts";
import { CopyFallback } from "../reader/CopyFallback.tsx";
import {
  COPY_TRANSCRIPT_DONE,
  COPY_TRANSCRIPT_HELP,
  COPY_TRANSCRIPT_LABEL,
  transcriptPlainText,
  useCopyText,
} from "../reader/copyText.ts";
import { TranscriptReader } from "../reader/TranscriptReader.tsx";
import { useFollowActive } from "../reader/useFollowActive.ts";
import { useTranslationProvider } from "../translation/TranslationContext.tsx";
import { useLineTranslations } from "../translation/useLineTranslations.ts";
import { deriveReviewHints } from "../uncertainty/reviewHints.ts";
import { resolvePlayerKey, type PlayerKeyAction } from "./playerKeys.ts";
import {
  ABOUT_MACHINE_TRANSCRIPT,
  ABOUT_PINYIN,
  transcriptCapabilities,
} from "./transcriptCapabilities.ts";
import styles from "./EpisodePage.module.css";

const REVIEW_HELP_ID = "review-help";
const LOCKED_HELP_ID = "learning-locked-help";
export const LEARNING_LOCKED_MESSAGE =
  "Learning tools become available after Pebble creates a real transcript.";
export const PREVIEW_BANNER =
  "This is placeholder text used to test local audio processing. It is not a transcription of your audio.";

export function EpisodePage({ episodeId }: { episodeId: string }) {
  const source = useEpisodeSource();
  const load = useCallback(
    () =>
      Promise.all([
        source.getEpisode(episodeId),
        source.getTranscript(episodeId),
        // Review hints are an enhancement; the transcript must still load without them.
        source.getReviewHints(episodeId).catch((error: unknown) => {
          console.warn("Pebble: review hints unavailable.", error);
          return [];
        }),
      ]),
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
  const [episode, transcript, reviewHints] = state.data;
  return <EpisodeView episode={episode} transcript={transcript} reviewHints={reviewHints} />;
}

function BackLink() {
  return (
    <Link to="/" className={styles.back}>
      <Icon name="back" size={18} />
      Library
    </Link>
  );
}

interface EpisodeViewProps {
  episode: ResolvedEpisode;
  transcript: Transcript;
  reviewHints: ReviewHint[];
}

function EpisodeView({ episode, transcript, reviewHints }: EpisodeViewProps) {
  const { segments } = transcript;
  const [audioRef, rawPlayer] = useAudioPlayer(episode.durationMs);
  const { toggle } = rawPlayer;
  // A replayed line starts a moment early (replayStart.ts); during that pre-roll it stays the
  // current line (useReplayCue.ts). Everything else follows the playhead.
  const replayCue = useReplayCue(audioRef, segments, episode.id, rawPlayer.currentTimeMs);
  const { start: startCue, fail: failCue, clear: clearCue } = replayCue;
  const rawSeek = rawPlayer.seek;
  // Every seek except a replay's own goes to an exact time and ends any replay cue.
  const seek = useCallback<AudioPlayer["seek"]>(
    (timeMs, options) => {
      clearCue();
      return rawSeek(timeMs, options);
    },
    [clearCue, rawSeek],
  );
  const player: AudioPlayer = { ...rawPlayer, seek };
  const activeIndex = replayCue.cuedIndex ?? findActiveSegmentIndex(segments, player.currentTimeMs);
  const readerRef = useRef<HTMLOListElement>(null);
  const { isFollowing, resume } = useFollowActive(readerRef, activeIndex);
  usePlaybackProgress(audioRef, episode.id, episode.durationMs);
  // Once anything plays here, the resume controls have done their job.
  const [startedHere, setStartedHere] = useState(false);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPlay = () => setStartedHere(true);
    audio.addEventListener("play", onPlay);
    return () => audio.removeEventListener("play", onPlay);
  }, [audioRef]);

  const learning = useLearning();
  const pinyin = usePinyin();
  const translations = useLineTranslations(episode.id);
  const translationProvider = useTranslationProvider();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [originalShown, setOriginalShown] = useState<ReadonlySet<string>>(new Set());
  const [confirmUnsaveId, setConfirmUnsaveId] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  // The title can change here (rename, local mode); everything else about the episode can't.
  const [title, setTitle] = useState(episode.title);
  const renamer = useEpisodeRename();
  const onRename =
    renamer && renamer.canRename(episode.id)
      ? async (next: string) => setTitle(await renamer.rename(episode.id, next))
      : undefined;
  // "Copy transcript": built only on click, kept only for the manual-copy fallback.
  const transcriptCopy = useCopyText();
  const [copiedTranscript, setCopiedTranscript] = useState("");
  const copyTranscriptButton = useRef<HTMLButtonElement>(null);

  const {
    showAll: pinyinShowAll,
    revealed: pinyinRevealed,
    status: pinyinStatus,
    convert: pinyinConvert,
  } = pinyin;
  const flagged = useMemo(() => deriveReviewHints(segments, reviewHints), [segments, reviewHints]);

  // What learners may do depends only on the transcript's provenance (transcriptCapabilities.ts).
  // Mock transcripts must never feed learning features; ASR transcripts have no English yet.
  const capabilities = transcriptCapabilities(transcript.provenance.kind);
  const learningLocked = !capabilities.learning;
  const translationAvailable = capabilities.translation === "available";
  const translationHidden = capabilities.translation === "hidden";

  const lines = useMemo(() => {
    const map = new Map<string, LineView>();
    for (const segment of segments) {
      const correction = learning.correctionFor(episode.id, segment.id);
      const text = correction?.correctedText ?? segment.text;
      const translation = translations.lines.get(segment.id);
      const pinyinVisible = pinyinShowAll || pinyinRevealed.has(segment.id);
      map.set(segment.id, {
        text,
        correction,
        showOriginal: originalShown.has(segment.id),
        needsReview: flagged.has(segment.id),
        pinyin: pinyinVisible
          ? {
              visible: true,
              status:
                pinyinStatus === "ready" ? "ready" : pinyinStatus === "error" ? "error" : "loading",
              text: pinyinConvert ? pinyinConvert(text) : null,
            }
          : { visible: false },
        // A translation of the previous text doesn't describe an edited line.
        translation:
          translationAvailable && translation?.forText === text ? translation : undefined,
        saved: learning.itemForSegment(episode.id, segment.id) !== null,
        confirmingUnsave: confirmUnsaveId === segment.id,
        editing: editingId === segment.id,
      });
    }
    return map;
  }, [
    segments,
    episode.id,
    learning,
    translations.lines,
    pinyinShowAll,
    pinyinRevealed,
    pinyinStatus,
    pinyinConvert,
    originalShown,
    flagged,
    confirmUnsaveId,
    editingId,
    translationAvailable,
  ]);

  // Row actions read the latest state through a ref so their identities stay stable and
  // memoized rows don't re-render on every playback frame.
  const latest = useRef({ lines, learning, pinyin, translations, episode, transcript });
  useLayoutEffect(() => {
    latest.current = { lines, learning, pinyin, translations, episode, transcript };
  });

  const toggleOriginalShown = useCallback((segmentId: string, show?: boolean) => {
    setOriginalShown((current) => {
      const next = new Set(current);
      if (show ?? !next.has(segmentId)) next.add(segmentId);
      else next.delete(segmentId);
      return next;
    });
  }, []);

  const actions = useMemo<LineActions>(
    () => ({
      // Line click and replay (R): start REPLAY_PREROLL_MS early. Arrow keys, learning-item
      // cues, resume and the scrubber still seek to exact times.
      select: (segment) => {
        resume();
        const { segments } = latest.current.transcript;
        const fromMs = replayStartMs(
          segments,
          segments.findIndex((s) => s.id === segment.id),
        );
        const token = startCue(segment, fromMs);
        void rawSeek(fromMs, { play: true })?.then((started) => {
          if (!started) failCue(token);
        });
      },
      togglePinyin: (segment) => {
        if (!learningLocked) latest.current.pinyin.toggleLine(segment.id);
      },
      retryPinyin: () => latest.current.pinyin.retry(),
      toggleTranslation: (segment) => {
        if (!translationAvailable) return;
        const view = latest.current.lines.get(segment.id);
        if (view) latest.current.translations.toggle(segment, view.text, view.translation);
      },
      retryTranslation: (segment) => {
        if (!translationAvailable) return;
        const view = latest.current.lines.get(segment.id);
        if (view) latest.current.translations.retry(segment, view.text);
      },
      toggleSave: (segment) => {
        if (learningLocked) return;
        const { learning, lines, pinyin, episode, transcript } = latest.current;
        const existing = learning.itemForSegment(episode.id, segment.id);
        if (existing) {
          if (existing.note) setConfirmUnsaveId(segment.id);
          else learning.removeItem(existing.id);
          return;
        }
        const text = lines.get(segment.id)?.text ?? segment.text;
        learning.saveItem(
          buildLearningItem({
            episode,
            transcript,
            segment,
            correction: learning.correctionFor(episode.id, segment.id),
            pinyin: pinyin.convert ? pinyin.convert(text) : null,
            translation: translationAvailable
              ? (translationProvider.peek({
                  episodeId: episode.id,
                  segmentId: segment.id,
                  text,
                  sourceText: segment.text,
                })?.text ?? null)
              : null,
          }),
        );
      },
      confirmUnsave: (segment) => {
        const { learning, episode } = latest.current;
        const existing = learning.itemForSegment(episode.id, segment.id);
        if (existing) learning.removeItem(existing.id);
        setConfirmUnsaveId(null);
      },
      cancelUnsave: () => setConfirmUnsaveId(null),
      startEdit: (segment) => {
        if (!learningLocked) setEditingId(segment.id);
      },
      cancelEdit: () => setEditingId(null),
      saveEdit: (segment, text) => {
        const result = latest.current.learning.saveCorrection(
          latest.current.episode.id,
          segment,
          text,
        );
        if (result !== "empty") setEditingId(null);
        return result;
      },
      revert: (segment) => {
        latest.current.learning.revertCorrection(latest.current.episode.id, segment.id);
        toggleOriginalShown(segment.id, false);
      },
      toggleOriginal: (segment) => toggleOriginalShown(segment.id),
    }),
    [
      resume,
      rawSeek,
      startCue,
      failCue,
      translationProvider,
      toggleOriginalShown,
      learningLocked,
      translationAvailable,
    ],
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

  const currentSegment = segments[Math.max(activeIndex, 0)];
  const replay = useCallback(() => {
    if (currentSegment) actions.select(currentSegment);
  }, [currentSegment, actions]);
  const previous = useCallback(() => goToIndex(activeIndex - 1), [goToIndex, activeIndex]);
  const next = useCallback(() => goToIndex(activeIndex + 1), [goToIndex, activeIndex]);

  useEffect(() => {
    const keyActions: Record<PlayerKeyAction, () => void> = {
      toggle,
      replay,
      previous,
      next,
      pinyin: () => currentSegment && actions.togglePinyin(currentSegment),
      translate: () => currentSegment && actions.toggleTranslation(currentSegment),
      save: () => currentSegment && actions.toggleSave(currentSegment),
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const action = resolvePlayerKey(event);
      if (!action) return;
      event.preventDefault(); // stops Space from scrolling or activating a focused button
      if (!event.repeat) keyActions[action]();
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
  }, [toggle, replay, previous, next, currentSegment, actions]);

  // Arriving from a learning item (#/episodes/:id?segment=…) cues up that line.
  const [searchParams] = useSearchParams();
  const cueSegmentId = searchParams.get("segment");
  // Resume controls: only for a saved position worth resuming (or a real finish), never when
  // the learner arrived to cue a specific line, and gone once playback starts. Nothing here
  // plays on its own; each control acts only when pressed.
  const saved = learning.playbackFor(episode.id);
  const listening = listeningState(saved, episode.durationMs);
  const showResume = !startedHere && !cueSegmentId && listening !== "not-started";
  const startOver = () => {
    learning.clearPlayback(episode.id);
    resume();
    seek(0, { play: true });
  };
  useEffect(() => {
    const segment = segments.find((s) => s.id === cueSegmentId);
    if (segment) seek(segment.startMs);
  }, [cueSegmentId, segments, seek]);

  return (
    <article className={styles.page}>
      <title>{`${title} · Pebble`}</title>
      {learningLocked ? (
        <div className={styles.previewBanner} role="note" aria-label="Preview transcript">
          <p>
            <strong>Preview transcript:</strong> {PREVIEW_BANNER}
          </p>
          <p className={styles.previewBannerNote}>
            Translation will be available after a real transcription and translation provider are
            connected.
          </p>
        </div>
      ) : null}
      <BackLink />

      <header className={styles.header}>
        <EpisodeTitle title={title} className={styles.title} onRename={onRename} />
        <div className={styles.titleRow}>
          {episode.titleZh ? (
            <p className={styles.titleZh} lang={transcript.language}>
              {episode.titleZh}
            </p>
          ) : null}
          <div className={styles.toolbar}>
            <button
              type="button"
              className={styles.toolButton}
              aria-pressed={pinyin.showAll}
              aria-busy={pinyin.status === "loading" || undefined}
              aria-disabled={learningLocked || undefined}
              aria-describedby={learningLocked ? LOCKED_HELP_ID : undefined}
              onClick={learningLocked ? undefined : pinyin.toggleAll}
            >
              {pinyin.showAll ? "Hide pinyin" : "Show pinyin"}
            </button>
            {capabilities.copy && segments.length > 0 ? (
              <button
                ref={copyTranscriptButton}
                type="button"
                className={styles.toolButton}
                title={COPY_TRANSCRIPT_HELP}
                onClick={() => {
                  const text = transcriptPlainText(segments, (id) => lines.get(id)?.text);
                  setCopiedTranscript(text);
                  transcriptCopy.copy(text); // inside the click: the browser sees the gesture
                }}
              >
                {/* Both labels share one cell, so the button never changes width. */}
                <span className={styles.labelStack}>
                  <span>
                    {transcriptCopy.status === "copied"
                      ? COPY_TRANSCRIPT_DONE
                      : COPY_TRANSCRIPT_LABEL}
                  </span>
                  <span aria-hidden="true">{COPY_TRANSCRIPT_DONE}</span>
                </span>
              </button>
            ) : null}
            <button
              type="button"
              className={styles.infoButton}
              aria-expanded={aboutOpen}
              aria-controls="transcript-about"
              aria-label="About this transcript"
              onClick={() => setAboutOpen((open) => !open)}
            >
              i
            </button>
          </div>
        </div>
      </header>

      {showResume && saved ? (
        <div className={styles.resumeBar} role="group" aria-label="Listening progress">
          {listening === "in-progress" ? (
            <>
              <button
                type="button"
                className={styles.resumeButton}
                onClick={() => {
                  resume();
                  seek(saved.positionMs, { play: true });
                }}
              >
                <Icon name="play" size={16} />
                Resume {formatTime(saved.positionMs)}
              </button>
              <button type="button" className={styles.textButton} onClick={startOver}>
                Start over
              </button>
            </>
          ) : (
            <>
              <span className={styles.finished}>Finished</span>
              <span aria-hidden="true">·</span>
              <button type="button" className={styles.textButton} onClick={startOver}>
                Listen again
              </button>
            </>
          )}
        </div>
      ) : null}

      <section aria-labelledby="transcript-heading">
        {/* The display toggles sit in the header row; the heading keeps the outline. */}
        <h2 id="transcript-heading" className={styles.visuallyHidden}>
          Transcript
        </h2>
        {learningLocked ? (
          <p id={LOCKED_HELP_ID} className={styles.help}>
            {LEARNING_LOCKED_MESSAGE}
          </p>
        ) : null}
        {aboutOpen ? (
          <p id="transcript-about" className={styles.help}>
            {/* Local-only: ASR transcripts exist only in local mode. */}
            {__PEBBLE_LOCAL__ && transcript.provenance.kind === "asr"
              ? ABOUT_MACHINE_TRANSCRIPT
              : ABOUT_PINYIN}
          </p>
        ) : null}
        {flagged.size > 0 ? (
          <p id={REVIEW_HELP_ID} className={styles.help}>
            <span className={styles.reviewSample}>May need review</span> Speech transcripts can
            occasionally mishear accents, names, or fast conversation. Listen again or edit this
            line if it looks wrong.
          </p>
        ) : null}
        <span className={styles.visuallyHidden} role="status">
          {transcriptCopy.status === "copied" ? COPY_TRANSCRIPT_DONE : ""}
        </span>
        {transcriptCopy.status === "failed" ? (
          <CopyFallback
            multiline
            label="Transcript text"
            text={copiedTranscript}
            language={transcript.language}
            onClose={() => {
              transcriptCopy.dismiss();
              copyTranscriptButton.current?.focus();
            }}
          />
        ) : null}
        <TranscriptReader
          ref={readerRef}
          segments={segments}
          activeIndex={activeIndex}
          language={transcript.language}
          lines={lines}
          actions={actions}
          reviewDescriptionId={REVIEW_HELP_ID}
          lockedDescriptionId={learningLocked ? LOCKED_HELP_ID : undefined}
          showTranslation={!translationHidden}
          showCopy={capabilities.copy}
        />
        <ShortcutSlot>
          <Shortcuts learningLocked={learningLocked} translationAvailable={translationAvailable} />
        </ShortcutSlot>
      </section>

      {!isFollowing && activeIndex >= 0 ? (
        <button type="button" className={styles.resume} onClick={resume}>
          Back to current line
        </button>
      ) : null}

      {/* crossOrigin: local-mode audio comes from the worker, which only answers allowlisted origins. */}
      <audio ref={audioRef} src={episode.audioUrl} preload="metadata" crossOrigin="anonymous" />
      <PlayerBar
        player={player}
        lineIndex={activeIndex}
        lineCount={segments.length}
        canGoPrevious={activeIndex > 0}
        canGoNext={activeIndex < segments.length - 1}
        onPrevious={previous}
        onReplay={replay}
        onNext={next}
      />
    </article>
  );
}

/** The keys that work on this page, as keycaps; P, T and S only where those tools work. */
function Shortcuts({
  learningLocked,
  translationAvailable,
}: {
  learningLocked: boolean;
  translationAvailable: boolean;
}) {
  const rows: [keys: string[], label: string][] = [
    [["Space"], "play/pause"],
    [["R"], "replay"],
    [["←", "→"], "previous/next"],
  ];
  if (!learningLocked) {
    rows.push([["P"], "pinyin"]);
    if (translationAvailable) rows.push([["T"], "English"]);
    rows.push([["S"], "save line"]);
  }
  return (
    <section className={styles.shortcuts} aria-label="Keyboard shortcuts">
      <p className={styles.shortcutsTitle} aria-hidden="true">
        Shortcuts
      </p>
      <dl className={styles.shortcutList}>
        {rows.map(([keys, label]) => (
          <div key={label} className={styles.shortcut}>
            <dt className={styles.keycaps}>
              {keys.map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
            </dt>
            <dd>{label}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
