import { createContext, useContext } from "react";
import { translationTextProblem, type TranslationHealth } from "@pebble/schema";

/**
 * Worker-backed English for local real-ASR transcripts (ADR 0008, docs/TRANSLATION.md). The
 * page talks to this interface only; the local app provides it (src/local), the demo never
 * does, so no provider name, copy or route reaches the demo bundle. Nothing here contacts the
 * provider: the worker does, for one line, when a learner asks.
 */

export type NewRequests = TranslationHealth["newRequests"];

export interface TranslationReadiness {
  /** A provider and key are set up on the worker. */
  configured: boolean;
  /** Whether a tap may send a line now, ask for consent first, or can't send at all. */
  newRequests: NewRequests;
}

export interface CachedEnglish {
  segmentId: string;
  fingerprint: string;
  text: string;
  createdAt: string;
}

/** A failure with the worker's fixed code; the worker's own message is never shown. */
export class WorkerTranslationError extends Error {
  readonly code: string;

  constructor(code: string, options?: { cause?: unknown }) {
    super(code, options);
    this.name = "WorkerTranslationError";
    this.code = code;
  }
}

export type ConsentOutcome = "granted" | "cancelled";

export interface WorkerTranslation {
  readiness: TranslationReadiness;
  /** The episode's cached English. Read-only: never sends anything to the provider. */
  loadCached(episodeId: string): Promise<CachedEnglish[]>;
  /** One line, on an explicit request. Rejects with WorkerTranslationError. */
  translate(request: {
    episodeId: string;
    segmentId: string;
    text: string;
  }): Promise<CachedEnglish>;
  /**
   * Shows the consent dialog. Resolves "granted" only after the learner confirms and the
   * worker records it; "cancelled" otherwise. Opening the dialog grants nothing.
   */
  requestConsent(): Promise<ConsentOutcome>;
  /**
   * Withdraws consent on the worker. Resolves only after the worker confirms; rejects with
   * WorkerTranslationError otherwise. Sends nothing to the provider and deletes nothing.
   */
  withdrawConsent(): Promise<void>;
  /**
   * Re-reads the worker's health (never translates). Resolves true and updates readiness when
   * the worker answered with translation readiness; false otherwise, changing nothing.
   */
  refresh(): Promise<boolean>;
  /** Fixed learner-facing copy for a worker code. */
  message(code: string): string;
  /** Shown under every provider translation. */
  attribution: { text: string; href: string };
  /** Local-only UI labels (kept out of the demo bundle). */
  labels: {
    stale: string;
    translateAgain: string;
    showSaved: string;
    hideSaved: string;
    settingsNav: string;
  };
}

export const WorkerTranslationContext = createContext<WorkerTranslation | null>(null);

/** Worker-backed English, or null (the demo, an older worker, or a worker that isn't ready). */
export function useWorkerTranslation(): WorkerTranslation | null {
  return useContext(WorkerTranslationContext);
}

/** Codes where an explicit "Try again" can plausibly succeed. */
export function canRetry(code: string): boolean {
  return ![
    "TRANSLATION_INVALID_TEXT",
    "TRANSLATION_NOT_ALLOWED",
    "TRANSLATION_OFF",
    "EPISODE_NOT_FOUND",
    "SEGMENT_NOT_FOUND",
  ].includes(code);
}

/** The text a line would be sent as: its displayed text in NFC, otherwise unchanged. */
export function submittedText(displayed: string): string {
  return displayed.normalize("NFC");
}

/** Whether the shared text rules allow sending this (already NFC) text. */
export function canSend(text: string): boolean {
  return translationTextProblem(text) === null;
}

/** SHA-256 of the exact submitted text's UTF-8 bytes, as lowercase hex (docs/TRANSLATION.md). */
export async function fingerprintOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
