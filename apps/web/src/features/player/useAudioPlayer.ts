import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export type AudioStatus = "loading" | "ready" | "error";

export interface AudioPlayer {
  status: AudioStatus;
  errorMessage: string | null;
  currentTimeMs: number;
  durationMs: number;
  isPlaying: boolean;
  playbackRate: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (timeMs: number, options?: { play?: boolean }) => void;
  setPlaybackRate: (rate: number) => void;
}

const MEDIA_ERROR_MESSAGES: Record<number, string> = {
  1: "Audio loading was aborted.",
  2: "A network error interrupted the audio.",
  3: "The audio file could not be decoded.",
  4: "The audio file is missing or its format isn't supported by this browser.",
};

const toMs = (seconds: number) => Math.round(seconds * 1000);

/**
 * Wraps an <audio> element: attach the returned ref to it and use the returned player. Time is polled with requestAnimationFrame
 * while playing so line highlighting tracks speech closely; `timeupdate` alone fires only
 * ~4 times a second.
 *
 * @param expectedDurationMs duration from metadata, shown until the media reports its own
 */
export function useAudioPlayer(
  expectedDurationMs: number,
): [audioRef: RefObject<HTMLAudioElement | null>, player: AudioPlayer] {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [status, setStatus] = useState<AudioStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [durationMs, setDurationMs] = useState(expectedDurationMs);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setRate] = useState(1);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const syncTime = () => setCurrentTimeMs(toMs(audio.currentTime));
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onReady = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0)
        setDurationMs(toMs(audio.duration));
      setStatus("ready");
    };
    const onError = () => {
      setStatus("error");
      setIsPlaying(false);
      setErrorMessage(
        MEDIA_ERROR_MESSAGES[audio.error?.code ?? 0] ?? "The audio could not be played.",
      );
    };
    const onRateChange = () => setRate(audio.playbackRate);

    const listeners: [string, () => void][] = [
      ["play", onPlay],
      ["pause", onPause],
      ["ended", onPause],
      ["loadedmetadata", onReady],
      ["canplay", onReady],
      ["error", onError],
      ["timeupdate", syncTime],
      ["seeked", syncTime],
      ["ratechange", onRateChange],
    ];
    for (const [type, listener] of listeners) audio.addEventListener(type, listener);
    // The element may already have finished loading metadata before this effect ran.
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) onReady();
    return () => {
      for (const [type, listener] of listeners) audio.removeEventListener(type, listener);
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!isPlaying || !audio) return;
    let frame = requestAnimationFrame(function tick() {
      setCurrentTimeMs(toMs(audio.currentTime));
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [isPlaying]);

  const play = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.play().catch((error: unknown) => {
      // AbortError: a newer seek/pause interrupted this play() — expected, not a failure.
      if (error instanceof DOMException && error.name === "AbortError") return;
      setErrorMessage(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "The browser blocked playback. Press play to start."
          : "The audio could not be played.",
      );
    });
  }, []);

  const pause = useCallback(() => audioRef.current?.pause(), []);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) play();
    else audio.pause();
  }, [play]);

  const seek = useCallback(
    (timeMs: number, options?: { play?: boolean }) => {
      const audio = audioRef.current;
      if (!audio) return;
      const clamped = Math.max(0, timeMs);
      audio.currentTime = clamped / 1000;
      setCurrentTimeMs(clamped); // update immediately so the highlight doesn't lag the seek
      if (options?.play) play();
    },
    [play],
  );

  const setPlaybackRate = useCallback((rate: number) => {
    const audio = audioRef.current;
    if (audio) audio.playbackRate = rate;
    setRate(rate);
  }, []);

  const player: AudioPlayer = {
    status,
    errorMessage,
    currentTimeMs,
    durationMs,
    isPlaying,
    playbackRate,
    play,
    pause,
    toggle,
    seek,
    setPlaybackRate,
  };
  return [audioRef, player];
}
