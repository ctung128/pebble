import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TranslationHealth } from "@pebble/schema";
import {
  WorkerTranslationContext,
  WorkerTranslationError,
  type CachedEnglish,
  type ConsentOutcome,
  type TranslationReadiness,
  type WorkerTranslation,
} from "../features/translation/workerTranslation.ts";
import { TranslationConsentDialog } from "./TranslationConsentDialog.tsx";
import {
  ATTRIBUTION,
  CONSENT_FAILED,
  LABELS,
  CONSENT_OUT_OF_DATE,
  translationMessage,
} from "./translationCopy.ts";
import { WorkerError } from "./workerClient.ts";
import { useWorker } from "./WorkerContext.tsx";

interface Overrides {
  /** The health report these were learned under; a newer report replaces them. */
  health?: object;
  /** Learned since the last health check: consent granted here, or required by the worker. */
  consent?: "current" | "required";
  /** The worker refused a request for Pebble's own monthly limit. */
  limitReached?: boolean;
}

interface PendingConsent {
  resolve: (outcome: ConsentOutcome) => void;
  promise: Promise<ConsentOutcome>;
}

/**
 * Worker-backed English (ADR 0008) for the reader, gated on health's `translation` block: an
 * older worker, or one that isn't ready, provides none. The browser never sees the API key and
 * never contacts the provider; it asks the worker, for one line, when a learner taps.
 */
export function LocalTranslationProvider({ children }: { children: ReactNode }) {
  const { client, status } = useWorker();
  const base = status.kind === "ready" ? status.health.translation : undefined;
  // An explicit refresh (translation settings) replaces the base report until the next one.
  const [refreshed, setRefreshed] = useState<{ base: object; health: TranslationHealth } | null>(
    null,
  );
  const health = base && refreshed?.base === base ? refreshed.health : base;
  const [stored, setStored] = useState<Overrides>({});
  // A fresh health report is the new baseline: overrides learned under another are ignored.
  const overrides = stored.health === health ? stored : {};
  const learn = useCallback(
    (change: Omit<Overrides, "health">) =>
      setStored((previous) => ({
        ...(previous.health === health ? previous : {}),
        ...change,
        health,
      })),
    [health],
  );
  const [dialog, setDialog] = useState<{ busy: boolean; problem: string | null } | null>(null);
  const pending = useRef<PendingConsent | null>(null);

  // Leaving local mode (or unmounting) never leaves a dialog promise hanging.
  useEffect(
    () => () => {
      pending.current?.resolve("cancelled");
      pending.current = null;
    },
    [],
  );

  const readiness = useMemo<TranslationReadiness | null>(() => {
    if (!health) return null;
    if (!health.configured) return { configured: false, newRequests: "off" };
    const consent = overrides.consent ?? health.consent;
    if (consent !== "current") return { configured: true, newRequests: "consent_required" };
    const limited = overrides.limitReached || health.newRequests === "local_limit_reached";
    return { configured: true, newRequests: limited ? "local_limit_reached" : "available" };
  }, [health, overrides.consent, overrides.limitReached]);

  const consentVersion = health?.consentVersion;

  const finishConsent = useCallback((outcome: ConsentOutcome) => {
    pending.current?.resolve(outcome);
    pending.current = null;
    setDialog(null);
  }, []);

  const confirm = useCallback(async () => {
    if (!consentVersion) return;
    setDialog({ busy: true, problem: null });
    try {
      const consent = await client.grantTranslationConsent(consentVersion);
      if (consent.status !== "current") throw new WorkerError("TRANSLATION_CONSENT_REQUIRED", "");
      learn({ consent: "current" });
      finishConsent("granted");
    } catch (error) {
      const outOfDate =
        error instanceof WorkerError && error.code === "TRANSLATION_CONSENT_REQUIRED";
      // Stays open with a fixed message; the learner may cancel or confirm again.
      setDialog({ busy: false, problem: outOfDate ? CONSENT_OUT_OF_DATE : CONSENT_FAILED });
    }
  }, [client, consentVersion, finishConsent, learn]);

  const value = useMemo<WorkerTranslation | null>(() => {
    if (!readiness) return null;
    return {
      readiness,
      attribution: ATTRIBUTION,
      labels: LABELS,
      message: translationMessage,
      async loadCached(episodeId: string): Promise<CachedEnglish[]> {
        try {
          return (await client.getEpisodeTranslations(episodeId)).translations;
        } catch (error) {
          throw asTranslationError(error);
        }
      },
      async translate(request) {
        try {
          const result = await client.translateLine(request);
          return {
            segmentId: result.segmentId,
            fingerprint: result.fingerprint,
            text: result.text,
            createdAt: result.createdAt,
          };
        } catch (error) {
          const failure = asTranslationError(error);
          if (failure.code === "TRANSLATION_CONSENT_REQUIRED") {
            learn({ consent: "required" });
          } else if (failure.code === "TRANSLATION_LOCAL_LIMIT") {
            learn({ limitReached: true });
          }
          throw failure;
        }
      },
      async withdrawConsent() {
        let consent;
        try {
          consent = await client.withdrawTranslationConsent();
        } catch (error) {
          throw asTranslationError(error);
        }
        // Success only once the worker confirms consent is no longer current.
        if (consent.status !== "required")
          throw new WorkerTranslationError("TRANSLATION_UNAVAILABLE");
        learn({ consent: "required" });
      },
      async refresh() {
        // Health only: nothing is translated, and nothing is assumed from the browser's clock.
        let result;
        try {
          result = await client.health();
        } catch {
          return false;
        }
        const translation = result.ok ? result.data.translation : undefined;
        if (!translation || !base) return false;
        setRefreshed({ base, health: translation });
        return true;
      },
      requestConsent() {
        if (pending.current) return pending.current.promise;
        let resolve: (outcome: ConsentOutcome) => void = () => {};
        const promise = new Promise<ConsentOutcome>((r) => {
          resolve = r;
        });
        pending.current = { resolve, promise };
        setDialog({ busy: false, problem: null });
        return promise;
      },
    };
  }, [client, readiness, learn, base]);

  return (
    <WorkerTranslationContext.Provider value={value}>
      {children}
      {dialog ? (
        <TranslationConsentDialog
          busy={dialog.busy}
          problem={dialog.problem}
          onConfirm={() => void confirm()}
          onCancel={() => finishConsent("cancelled")}
        />
      ) : null}
    </WorkerTranslationContext.Provider>
  );
}

/** Only the worker's fixed code survives; its message, and anything else, is dropped. */
function asTranslationError(error: unknown): WorkerTranslationError {
  if (error instanceof WorkerTranslationError) return error;
  const code =
    error instanceof WorkerError && /^[A-Z_]+$/.test(error.code) && error.code !== "UNREACHABLE"
      ? error.code
      : "TRANSLATION_UNAVAILABLE";
  return new WorkerTranslationError(code);
}
