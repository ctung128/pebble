import {
  useWorkerTranslation,
  type TranslationUsage,
} from "../features/translation/workerTranslation.ts";
import { USAGE } from "./translationCopy.ts";
import styles from "./TranslationUsageMeter.module.css";

/** At or under this share left, the meter turns to the warning colour. */
const LOW_SHARE = 0.2;

/** Requests left this month; none once either of Pebble's limits is spent. */
export function requestsLeft(usage: TranslationUsage): number {
  if (usage.charactersUsed >= usage.characterLimit) return 0;
  return Math.max(0, usage.requestLimit - usage.requestsUsed);
}

/** The first day of the month after `period` ("YYYY-MM", UTC), e.g. "Nov 1". */
export function resetDate(period: string): string {
  const [year, month] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 1)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Local English's monthly allowance, pinned to the bottom of the sidebar: how many new-line
 * translations are left, a bar, and when it resets. Shown only while
 * translation is set up; it reads worker health and never sends anything.
 */
export function TranslationUsageMeter() {
  const usage = useWorkerTranslation()?.usage;
  if (!usage) return null;
  const left = requestsLeft(usage);
  const limit = usage.requestLimit;
  const state = left === 0 ? "none" : left / limit <= LOW_SHARE ? "low" : "ok";

  return (
    <section className={styles.meter} data-state={state} aria-labelledby="usage-title">
      <h2 id="usage-title" className={styles.title}>
        {USAGE.title}
      </h2>
      <p className={styles.count}>
        <span className={styles.left}>{USAGE.left(left)}</span>
        <span className={styles.of}>{USAGE.of(limit)}</span>
      </p>
      <div
        className={styles.track}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={left}
        aria-valuetext={USAGE.meter(left, limit)}
        aria-labelledby="usage-title"
      >
        <div className={styles.fill} style={{ width: `${(left / limit) * 100}%` }} />
      </div>
      {state === "ok" ? null : (
        <p className={styles.note}>{state === "none" ? USAGE.none : USAGE.low}</p>
      )}
      <p className={styles.footer}>{USAGE.resets(resetDate(usage.period))}</p>
    </section>
  );
}
