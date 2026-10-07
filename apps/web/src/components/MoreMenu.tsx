import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Icon } from "./Icon.tsx";
import styles from "./MoreMenu.module.css";

export interface MoreMenuItem {
  key: string;
  label: ReactNode;
  /** Runs inside the click, so clipboard writes keep the browser's user gesture. */
  onSelect: () => void;
  /** Shown but inert (aria-disabled), e.g. while learning is locked. */
  disabled?: boolean;
  describedBy?: string;
  title?: string;
}

interface MoreMenuProps {
  /** The trigger's accessible name, e.g. "Transcript actions". */
  label: string;
  items: MoreMenuItem[];
  /** The trigger button, so callers can return focus to it. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

/**
 * A "⋯" button that opens a small menu of actions (WAI-ARIA menu button). Arrow keys, Home and
 * End move between items; Escape closes and returns focus to the button; Tab or a click outside
 * closes it. Choosing an item closes the menu and returns focus to the button.
 */
export function MoreMenu({ label, items, triggerRef }: MoreMenuProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const ownTrigger = useRef<HTMLButtonElement | null>(null);
  const trigger = triggerRef ?? ownTrigger;
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const move = (to: number) => {
    const count = items.length;
    itemRefs.current[((to % count) + count) % count]?.focus();
  };

  return (
    <div ref={root} className={styles.root}>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="more" size={20} />
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className={styles.menu}
          onKeyDown={(event) => {
            const current = itemRefs.current.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === "ArrowDown") move(current + 1);
            else if (event.key === "ArrowUp") move(current - 1);
            else if (event.key === "Home") move(0);
            else if (event.key === "End") move(items.length - 1);
            else if (event.key === "Escape") close(true);
            else if (event.key === "Tab") close(false);
            else return;
            if (event.key !== "Tab") event.preventDefault();
            event.stopPropagation();
          }}
        >
          {items.map((item, index) => (
            <button
              key={item.key}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={styles.item}
              title={item.title}
              aria-disabled={item.disabled || undefined}
              aria-describedby={item.describedBy}
              onClick={() => {
                if (item.disabled) return;
                item.onSelect();
                close(true);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
