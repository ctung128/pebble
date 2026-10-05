import { useId, type CSSProperties } from "react";
import { Icon } from "../../components/Icon.tsx";
import { formatTime } from "../../lib/formatTime.ts";
import type { AudioPlayer } from "./useAudioPlayer.ts";
import styles from "./PlayerBar.module.css";

const SPEEDS = [0.75, 0.9, 1] as const;

interface PlayerBarProps {
  player: AudioPlayer;
  /** Index of the current line (-1 before the first), for "Line X of Y". */
  lineIndex: number;
  lineCount: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPrevious: () => void;
  onReplay: () => void;
  onNext: () => void;
}

/**
 * The docked player (design system AudioPlayer): play/pause as the pebble, then line
 * navigation, the progress track and playback speed.
 */
export function PlayerBar({
  player,
  lineIndex,
  lineCount,
  canGoPrevious,
  canGoNext,
  onPrevious,
  onReplay,
  onNext,
}: PlayerBarProps) {
  const disabled = player.status === "error";
  const speedName = useId();

  return (
    <div className={styles.bar} role="region" aria-label="Player">
      <div className={styles.inner}>
        <div className={styles.controls}>
          <button
            type="button"
            className={styles.playButton}
            onClick={player.toggle}
            disabled={disabled}
            aria-label={player.isPlaying ? "Pause" : "Play"}
            title={player.isPlaying ? "Pause (Space)" : "Play (Space)"}
          >
            <Icon name={player.isPlaying ? "pause" : "play"} size={28} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            onClick={onPrevious}
            disabled={disabled || !canGoPrevious}
            aria-label="Previous line"
            title="Previous line (←)"
          >
            <Icon name="previous" />
          </button>
          <button
            type="button"
            className={`${styles.iconButton} ${styles.replay}`}
            onClick={onReplay}
            disabled={disabled}
            aria-label="Replay current line"
            title="Replay current line (R)"
          >
            <Icon name="replay" />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            onClick={onNext}
            disabled={disabled || !canGoNext}
            aria-label="Next line"
            title="Next line (→)"
          >
            <Icon name="next" />
          </button>
        </div>

        <div className={styles.timeline}>
          <p className={styles.times}>
            <span>
              <span className={styles.now}>{formatTime(player.currentTimeMs)}</span>
              {lineIndex >= 0 ? ` · Line ${lineIndex + 1} of ${lineCount}` : null}
            </span>
            <span>{formatTime(player.durationMs)}</span>
          </p>
          <input
            type="range"
            className={styles.scrubber}
            min={0}
            max={player.durationMs}
            step={100}
            value={Math.min(player.currentTimeMs, player.durationMs)}
            onChange={(event) => player.seek(Number(event.target.value))}
            disabled={disabled}
            aria-label="Seek"
            aria-valuetext={`${formatTime(player.currentTimeMs)} of ${formatTime(player.durationMs)}`}
            style={
              {
                "--progress": `${(player.currentTimeMs / Math.max(player.durationMs, 1)) * 100}%`,
              } as CSSProperties
            }
          />
        </div>

        <fieldset className={styles.speed} disabled={disabled}>
          <legend className={styles.visuallyHidden}>Playback speed</legend>
          {SPEEDS.map((speed) => (
            <label key={speed} className={styles.speedOption}>
              <input
                type="radio"
                className={styles.visuallyHidden}
                name={speedName}
                value={speed}
                checked={player.playbackRate === speed}
                onChange={() => player.setPlaybackRate(speed)}
              />
              {speed}×
            </label>
          ))}
        </fieldset>
      </div>

      {player.errorMessage ? (
        <p className={styles.error} role="alert">
          {player.errorMessage}
        </p>
      ) : null}
    </div>
  );
}
