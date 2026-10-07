import { useCallback, useEffect, useState, type RefObject } from "react";
import logoMark from "../assets/logo-mark.png";
import styles from "./GuideTip.module.css";

/**
 * What makes a tip appear. Open-ended: later tips add their own trigger types here.
 * - `episode-progress`: the current line passes `at` of the episode's lines, or the learner
 *   (not Pebble's own follow-scroll) scrolls that far through the transcript.
 */
export type GuideTrigger = { type: "episode-progress"; at: number };

/** Where the learner is in the episode, from the episode view. */
export interface EpisodeProgress {
  /** The current line's index; -1 before anything is current. */
  index: number;
  count: number;
}

interface GuideTipProps {
  /** Stable per tip: it shows at most once per browser session. */
  id: string;
  trigger: GuideTrigger;
  /** One sentence. A leading "Tip:" is set in the medium weight. */
  message: string;
  /** An optional link, opened in a new tab. */
  action?: { label: string; href: string };
  progress: EpisodeProgress;
  /** The transcript list: the tip measures it (to sit beside the current line) and its scroll. */
  anchor: RefObject<HTMLElement | null>;
  /** True once the learner has scrolled the page themselves (Pebble stopped following). */
  userScrolled: boolean;
  /** Only on devices with a mouse (the tip teaches hovering). */
  requiresHover?: boolean;
}

/**
 * The tip is measured this long after its trigger, once useFollowActive's smooth scroll to the
 * current line has settled, so it lands level with that line (and arrives a beat after it).
 */
export const SETTLE_MS = 450;
/** --duration-base: the single exit fade. */
const EXIT_MS = 160;
/** Room the margin needs beside the column: gap, 44px character, gap, 234px bubble, edge. */
const MARGIN_NEEDED = 36 + 44 + 12 + 234 + 16;

const STORAGE_PREFIX = "pebble.guideTip.";
/** Used when sessionStorage is blocked (private windows, blocked site data). */
const seenInMemory = new Set<string>();

export function hasSeenTip(id: string): boolean {
  if (seenInMemory.has(id)) return true;
  try {
    return window.sessionStorage.getItem(STORAGE_PREFIX + id) === "seen";
  } catch {
    return false;
  }
}

function markTipSeen(id: string): void {
  seenInMemory.add(id);
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + id, "seen");
  } catch {
    // The in-memory record keeps it to once per page session.
  }
}

/** For tests: forget the in-memory record. */
export function resetGuideTipsForTests(): void {
  seenInMemory.clear();
}

function matches(query: string, fallback: boolean): boolean {
  return typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback;
}

function lineProgress({ index, count }: EpisodeProgress): number {
  return count > 0 && index >= 0 ? (index + 1) / count : 0;
}

/** How far the middle of the viewport has moved through the transcript, 0–1. */
function scrollProgress(anchor: HTMLElement | null): number {
  if (!anchor) return 0;
  const rect = anchor.getBoundingClientRect();
  if (rect.height <= 0) return 0;
  return Math.min(1, Math.max(0, (window.innerHeight / 2 - rect.top) / rect.height));
}

type Phase = "waiting" | "shown" | "leaving" | "done";
interface Placement {
  variant: "margin" | "inline";
  left: number;
  top: number;
}

/**
 * Beside the current line in the right margin when there's room for the character and bubble
 * (kept inside the band useFollowActive holds the current line in, 18–66% down), else inline.
 */
function measurePlacement(list: HTMLElement | null, index: number): Placement {
  if (!list) return { variant: "inline", left: 0, top: 0 };
  const rect = list.getBoundingClientRect();
  if (window.innerWidth - rect.right < MARGIN_NEEDED) return { variant: "inline", left: 0, top: 0 };
  const band = { top: window.innerHeight * 0.18, bottom: window.innerHeight * 0.66 };
  const row = list.querySelector<HTMLElement>(`[data-segment-index="${index}"]`);
  const rowTop = row?.getBoundingClientRect().top ?? band.top;
  return {
    variant: "margin",
    left: rect.right + 36,
    top: Math.min(Math.max(rowTop, band.top), band.bottom),
  };
}

/**
 * A single guidance moment from the Pebble character: one tip, shown once per session when
 * its trigger fires, then gone. Not a chatbot: no input, no history, no persistent button.
 * It never takes focus, adds no key handlers and only catches pointer events on its bubble.
 */
export function GuideTip({
  id,
  trigger,
  message,
  action,
  progress,
  anchor,
  userScrolled,
  requiresHover = false,
}: GuideTipProps) {
  const [phase, setPhase] = useState<Phase>(() => (hasSeenTip(id) ? "done" : "waiting"));
  const [scrolled, setScrolled] = useState(0);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const reducedMotion = matches("(prefers-reduced-motion: reduce)", false);
  const canHover = !requiresHover || matches("(hover: hover) and (pointer: fine)", true);

  // Learner scrolling only: Pebble's own follow-scroll moves the page too.
  useEffect(() => {
    if (phase !== "waiting" || !userScrolled) return;
    const onScroll = () => setScrolled((value) => Math.max(value, scrollProgress(anchor.current)));
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [phase, userScrolled, anchor]);

  const reached = Math.max(lineProgress(progress), scrolled);
  const ready = phase === "waiting" && canHover && reached >= trigger.at;

  // Show once, at the threshold, measured after the current line has settled.
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      if (hasSeenTip(id)) {
        setPhase("done");
        return;
      }
      markTipSeen(id);
      setPlacement(measurePlacement(anchor.current, progress.index));
      setPhase("shown");
    }, SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [ready, id, anchor, progress.index]);

  // Keep the margin position (or switch variants) when the window is resized.
  useEffect(() => {
    if (phase !== "shown") return;
    const onResize = () =>
      setPlacement((current) => {
        const next = measurePlacement(anchor.current, progress.index);
        return current && next.variant === "margin" ? { ...next, top: current.top } : next;
      });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [phase, anchor, progress.index]);

  // It stays until the learner dismisses it.
  const leave = useCallback(() => {
    setPhase((current) => (current === "shown" ? "leaving" : current));
  }, []);

  useEffect(() => {
    if (phase !== "leaving") return;
    const timer = window.setTimeout(() => setPhase("done"), reducedMotion ? 0 : EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [phase, reducedMotion]);

  if ((phase !== "shown" && phase !== "leaving") || !placement) return null;

  const lead = /^Tip:\s/.exec(message);
  const text = (
    <p className={styles.text}>
      {lead ? (
        <>
          <span className={styles.lead}>Tip:</span> {message.slice(lead[0].length)}
        </>
      ) : (
        message
      )}
    </p>
  );
  const controls = (
    <>
      {action ? (
        <a className={styles.link} href={action.href} target="_blank" rel="noopener noreferrer">
          {action.label}
        </a>
      ) : null}
      <button type="button" className={styles.dismiss} aria-label="Dismiss tip" onClick={leave}>
        Dismiss
      </button>
    </>
  );

  return (
    <div
      className={styles.tip}
      data-variant={placement.variant}
      data-phase={phase}
      data-reduced-motion={reducedMotion || undefined}
      style={
        placement.variant === "margin"
          ? { left: `${placement.left}px`, top: `${placement.top}px` }
          : undefined
      }
    >
      <img
        className={styles.character}
        src={logoMark}
        alt=""
        aria-hidden="true"
        width={placement.variant === "margin" ? 44 : 28}
        height={placement.variant === "margin" ? 44 : 28}
      />
      <div className={styles.bubble} role="status">
        {text}
        <div className={styles.row}>{controls}</div>
      </div>
    </div>
  );
}
