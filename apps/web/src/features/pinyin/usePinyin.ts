import { useCallback, useRef, useState } from "react";
import { loadPinyin, type PinyinConverter } from "./loadPinyin.ts";

export type PinyinStatus = "idle" | "loading" | "ready" | "error";

/** Pinyin visibility for one episode view. Hidden by default; the converter loads on first use. */
export function usePinyin() {
  const [status, setStatus] = useState<PinyinStatus>("idle");
  const [convert, setConvert] = useState<PinyinConverter | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());

  const requested = useRef(false);

  const ensureLoaded = useCallback(() => {
    if (requested.current) return;
    requested.current = true;
    setStatus("loading");
    loadPinyin().then(
      (converter) => {
        setConvert(() => converter);
        setStatus("ready");
      },
      () => {
        requested.current = false;
        setStatus("error");
      },
    );
  }, []);

  const toggleAll = useCallback(() => {
    setShowAll((on) => !on);
    ensureLoaded();
  }, [ensureLoaded]);

  const toggleLine = useCallback(
    (segmentId: string) => {
      setRevealed((current) => {
        const next = new Set(current);
        if (next.has(segmentId)) next.delete(segmentId);
        else next.add(segmentId);
        return next;
      });
      ensureLoaded();
    },
    [ensureLoaded],
  );

  return { status, convert, showAll, revealed, toggleAll, toggleLine, retry: ensureLoaded };
}
