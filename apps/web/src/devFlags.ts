/**
 * Development-only switches read from the page query string (before the #), used to check
 * degraded states by hand. They compile to `false` in production builds.
 *
 *   ?storage=session    behave as if browser storage were unavailable
 *   ?translation=fail   make every translation request fail (retryable)
 */
const params = import.meta.env.DEV ? new URLSearchParams(window.location.search) : null;

export const devFlags = {
  sessionOnlyStorage: params?.get("storage") === "session",
  failTranslations: params?.get("translation") === "fail",
};
