import type { CSSProperties } from "react";
import { Icon } from "../../components/Icon.tsx";
import { formatTime } from "../../lib/formatTime.ts";
import type { AudioPlayer } from "./useAudioPlayer.ts";
import styles from "./PlayerBar.module.css";

const SPEEDS = [0.75, 0.9, 1] as const;

interface PlayerBarProps {
  player: AudioPlayer;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPrevious: () => void;
  onReplay: () => void;
  onNext: () => void;
}

export function PlayerBar({
  player,
  canGoPrevious,
  canGoNext,
  onPrevious,
  onReplay,
  onNext,
}: PlayerBarProps) {
  const disabled = player.status === "error";

  return (
    <div className={styles.bar} role="region" aria-label="Player">
      <div className={styles.inner}>
        <div className={styles.controls}>
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
            className={styles.iconButton}
            onClick={onReplay}
            disabled={disabled}
            aria-label="Replay current line"
            title="Replay current line (R)"
          >
            <Icon name="replay" />
          </button>
          <button
            type="button"
            className={styles.playButton}
            onClick={player.toggle}
            disabled={disabled}
            aria-label={player.isPlaying ? "Pause" : "Play"}
            title={player.isPlaying ? "Pause (Space)" : "Play (Space)"}
          >
            <Icon name={player.isPlaying ? "pause" : "play"} size={24} />
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
          <span className={styles.time}>{formatTime(player.currentTimeMs)}</span>
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
          <span className={styles.time}>{formatTime(player.durationMs)}</span>
        </div>

        <label className={styles.speed}>
          <span className={styles.visuallyHidden}>Playback speed</span>
          <select
            value={player.playbackRate}
            onChange={(event) => player.setPlaybackRate(Number(event.target.value))}
            disabled={disabled}
          >
            {SPEEDS.map((speed) => (
              <option key={speed} value={speed}>
                {speed}×
              </option>
            ))}
          </select>
        </label>
      </div>

      {player.errorMessage ? (
        <p className={styles.error} role="alert">
          {player.errorMessage}
        </p>
      ) : null}
    </div>
  );
}
