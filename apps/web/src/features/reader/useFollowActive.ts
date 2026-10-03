import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** The active line is left alone while it sits inside this band of the viewport. */
const COMFORT_TOP = 0.18;
const COMFORT_BOTTOM = 0.66;
/**
 * Our own scroll counts as finished at `scrollend`, or — for browsers without it — once
 * scroll events have been quiet this long. Tying this to the scroll itself (not a fixed
 * timeout) keeps long or slow smooth scrolls from being mistaken for the user's.
 */
const SCROLL_SETTLE_MS = 200;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Keeps the active transcript line in view while following. Any manual scroll (wheel,
 * touch, keyboard, scrollbar) stops following until `resume()` is called, so the reader
 * never yanks the page away from what the user is looking at.
 */
export function useFollowActive(containerRef: RefObject<HTMLElement | null>, activeIndex: number) {
  const [isFollowing, setIsFollowing] = useState(true);
  const ownScroll = useRef({ active: false, settleTimer: 0 });

  useEffect(() => {
    const own = ownScroll.current;
    const settleLater = () => {
      window.clearTimeout(own.settleTimer);
      own.settleTimer = window.setTimeout(() => (own.active = false), SCROLL_SETTLE_MS);
    };
    const stopFollowing = () => {
      own.active = false; // the user took over mid-scroll
      setIsFollowing(false);
    };
    const onScroll = () => {
      if (own.active) settleLater();
      // A hidden page can't be scrolled by its user; ignore browser-driven scroll there.
      else if (document.visibilityState !== "hidden") setIsFollowing(false);
    };
    const onScrollEnd = () => {
      window.clearTimeout(own.settleTimer);
      own.active = false;
    };

    window.addEventListener("wheel", stopFollowing, { passive: true });
    window.addEventListener("touchmove", stopFollowing, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scrollend", onScrollEnd);
    return () => {
      window.clearTimeout(own.settleTimer);
      window.removeEventListener("wheel", stopFollowing);
      window.removeEventListener("touchmove", stopFollowing);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("scrollend", onScrollEnd);
    };
  }, []);

  useEffect(() => {
    if (!isFollowing || activeIndex < 0) return;
    const row = containerRef.current?.querySelector<HTMLElement>(
      `[data-segment-index="${activeIndex}"]`,
    );
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const height = window.innerHeight;
    if (rect.top >= height * COMFORT_TOP && rect.bottom <= height * COMFORT_BOTTOM) return;

    const own = ownScroll.current;
    own.active = true;
    // Covers the case where the browser decides no scroll is needed and fires no events.
    window.clearTimeout(own.settleTimer);
    own.settleTimer = window.setTimeout(() => (own.active = false), SCROLL_SETTLE_MS * 2);
    row.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [activeIndex, isFollowing, containerRef]);

  const resume = useCallback(() => setIsFollowing(true), []);

  return { isFollowing, resume };
}
