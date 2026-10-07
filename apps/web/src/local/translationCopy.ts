/**
 * Learner-facing translation copy (docs/TRANSLATION.md). Local mode only: it names the provider,
 * so it must never reach the demo bundle.
 */

/** The same copy as docs/TRANSLATION.md#errors (checked by a test). */
export const TRANSLATION_MESSAGES: Record<string, string> = {
  TRANSLATION_OFF: "English isn't set up for Pebble on this computer.",
  TRANSLATION_CONSENT_REQUIRED: "Allow translation with DeepL first.",
  TRANSLATION_LOCAL_LIMIT:
    "Pebble's monthly translation limit on this computer has been reached. Saved English still shows.",
  TRANSLATION_RATE_LIMITED: "DeepL is busy right now. Wait a moment, then tap English again.",
  TRANSLATION_PROVIDER_QUOTA:
    "Your DeepL account's character allowance has been reached. Check your DeepL account.",
  TRANSLATION_KEY_REJECTED: "DeepL didn't accept the key set up for Pebble.",
  TRANSLATION_REQUEST_REJECTED: "DeepL couldn't translate this line.",
  TRANSLATION_UNAVAILABLE: "Translation is unavailable right now. Try again later.",
  TRANSLATION_INVALID_TEXT: "This line can't be translated.",
  TRANSLATION_NOT_ALLOWED: "Lines from this transcript can't be translated.",
  EPISODE_NOT_FOUND: "This episode or line no longer exists.",
  SEGMENT_NOT_FOUND: "This episode or line no longer exists.",
};

/** Fixed copy for a worker code; unknown codes (and client-side failures) read as unavailable. */
export function translationMessage(code: string): string {
  return TRANSLATION_MESSAGES[code] ?? (TRANSLATION_MESSAGES.TRANSLATION_UNAVAILABLE as string);
}

/** Dialog copy (docs/TRANSLATION.md#consent): exact, with no expandable details. */
export const CONSENT_TITLE = "Translate with DeepL?";
export const CONSENT_BODY =
  "Only this line's Chinese text is sent to DeepL. Your audio and the rest of the transcript stay on this computer. DeepL's free-API terms allow indefinite storage; don't send personal or confidential information.";
export const CONSENT_CONFIRM = "Translate";
export const CONSENT_CANCEL = "Cancel";
/** A consent version the worker no longer accepts (409 TRANSLATION_CONSENT_REQUIRED). */
export const CONSENT_OUT_OF_DATE =
  "That consent is out of date. Reload Pebble and review it again.";
export const CONSENT_FAILED =
  "Pebble couldn't record your choice. No translation request was sent.";

export const LABELS = {
  stale: "English for an earlier version of this line",
  translateAgain: "Translate again",
  showSaved: "Show saved English",
  hideSaved: "Hide saved English",
};

export const ATTRIBUTION = {
  text: "Translated by DeepL (deepl.com)",
  href: "https://www.deepl.com",
};
