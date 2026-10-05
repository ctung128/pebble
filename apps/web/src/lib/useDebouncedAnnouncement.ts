import { useEffect, useState } from "react";

/** The latest message, once typing has paused (so each keystroke isn't announced). */
export function useDebouncedAnnouncement(message: string, delayMs = 600): string {
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setAnnounced(message), delayMs);
    return () => window.clearTimeout(timer);
  }, [message, delayMs]);
  return announced;
}
