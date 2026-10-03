export type PlayerKeyAction = "toggle" | "replay" | "previous" | "next";

interface KeyLike {
  key: string;
  target: EventTarget | null;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && target.type !== "range" && target.type !== "button";
}

/**
 * Maps a keydown to an episode-page action. Space is play/pause everywhere on the page
 * (including on focused line buttons, whose Enter key still activates them). Arrow keys
 * are left to the seek slider when it has focus. Text fields and modified keys are ignored.
 */
export function resolvePlayerKey(event: KeyLike): PlayerKeyAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (isTextEntry(event.target)) return null;

  switch (event.key) {
    case " ":
      return "toggle";
    case "r":
    case "R":
      return "replay";
    case "ArrowLeft":
    case "ArrowRight": {
      const onSlider = event.target instanceof HTMLInputElement && event.target.type === "range";
      if (onSlider) return null;
      return event.key === "ArrowLeft" ? "previous" : "next";
    }
    default:
      return null;
  }
}
