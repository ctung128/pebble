import { createContext, useContext, type ReactNode } from "react";
import type { Segment, Transcript } from "@pebble/schema";
import type { MoreMenuItem } from "../../components/MoreMenu.tsx";

/**
 * Extra speaker information a content source can lay over the reader (local mode only). The
 * transcript itself is never changed: labels apply to the displayed lines only, so copy, English,
 * saving and corrections keep using the original segments.
 */
export interface SpeakerOverlay {
  /** Display label per segment id (e.g. "A"), or null for none. Unlisted lines keep their own. */
  labels: ReadonlyMap<string, string | null>;
  /**
   * A confirmed display name per segment id, announced with the letter ("Speaker A, Host") but
   * never shown in or added to the line's text.
   */
  spokenNames: ReadonlyMap<string, string>;
  /** Shown between the episode header and the transcript. */
  panel: ReactNode;
  /** An extra control for each line, or null. Must keep its identity while nothing changes. */
  lineAccessory: ((segment: Segment) => ReactNode) | null;
  /** Extra items for the transcript actions menu (e.g. showing a tucked-away panel). */
  menuItems: MoreMenuItem[];
}

export interface SpeakerOverlayOptions {
  /** Moves focus to the transcript actions menu (after the panel is tucked away). */
  focusMenu: () => void;
}

export interface SpeakerOverlaySource {
  /** A hook: called once per render of the episode view, in the same order every time. */
  useOverlay(
    episodeId: string,
    transcript: Transcript,
    options: SpeakerOverlayOptions,
  ): SpeakerOverlay | null;
}

/** The demo, and any app without a local provider: no overlay and no requests. */
const NONE: SpeakerOverlaySource = { useOverlay: () => null };

export const SpeakerOverlayContext = createContext<SpeakerOverlaySource>(NONE);

export function useSpeakerOverlay(
  episodeId: string,
  transcript: Transcript,
  options: SpeakerOverlayOptions,
): SpeakerOverlay | null {
  return useContext(SpeakerOverlayContext).useOverlay(episodeId, transcript, options);
}
