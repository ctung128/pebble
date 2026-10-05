import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

const ShortcutSlotContext = createContext<HTMLElement | null>(null);

/** Provided by the app shell: the sidebar area that holds the current page's shortcuts. */
export const ShortcutSlotProvider = ShortcutSlotContext.Provider;

/**
 * Renders its children in the shell's sidebar shortcut area, or in place when there is no
 * shell (a page rendered on its own, as in tests).
 */
export function ShortcutSlot({ children }: { children: ReactNode }) {
  const target = useContext(ShortcutSlotContext);
  return target ? createPortal(children, target) : children;
}
