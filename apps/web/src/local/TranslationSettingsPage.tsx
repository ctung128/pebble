import { useState } from "react";
import { useWorkerTranslation } from "../features/translation/workerTranslation.ts";
import { SETTINGS, TRANSLATION_MESSAGES } from "./translationCopy.ts";
import styles from "./local.module.css";

type Action =
  | { kind: "idle" }
  | { kind: "busy"; what: "withdraw" | "check" }
  | { kind: "withdrawn" }
  | { kind: "failed"; what: "withdraw" | "check"; message: string };

/**
 * Translation settings (docs/TRANSLATION.md#consent), local mode only: what is sent, Withdraw,
 * and an explicit re-check after Pebble's monthly limit was reached. Nothing here translates,
 * retries, or deletes cached English or saved items.
 */
export function TranslationSettingsPage() {
  const translation = useWorkerTranslation();
  const [action, setAction] = useState<Action>({ kind: "idle" });
  const busy = action.kind === "busy";

  if (!translation) {
    return (
      <article className={styles.page}>
        <h1>{SETTINGS.title}</h1>
        <p>{TRANSLATION_MESSAGES.TRANSLATION_OFF}</p>
      </article>
    );
  }

  const { newRequests } = translation.readiness;
  const allowed = newRequests === "available" || newRequests === "local_limit_reached";

  const withdraw = async () => {
    setAction({ kind: "busy", what: "withdraw" });
    try {
      await translation.withdrawConsent();
      setAction({ kind: "withdrawn" });
    } catch {
      setAction({ kind: "failed", what: "withdraw", message: SETTINGS.withdrawFailed });
    }
  };

  const checkAgain = async () => {
    setAction({ kind: "busy", what: "check" });
    const ok = await translation.refresh();
    setAction(
      ok ? { kind: "idle" } : { kind: "failed", what: "check", message: SETTINGS.checkFailed },
    );
  };

  return (
    <article className={styles.page}>
      <h1>{SETTINGS.title}</h1>
      <section aria-label="Status">
        {newRequests === "off" ? (
          <p>{TRANSLATION_MESSAGES.TRANSLATION_OFF}</p>
        ) : allowed ? (
          <p>
            {SETTINGS.allowed}{" "}
            <button
              type="button"
              aria-busy={(busy && action.what === "withdraw") || undefined}
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) void withdraw();
              }}
            >
              {SETTINGS.withdraw}
            </button>
          </p>
        ) : action.kind === "withdrawn" ? null : (
          <p>{SETTINGS.notAllowed}</p>
        )}
        {newRequests === "local_limit_reached" ? (
          <p>
            {TRANSLATION_MESSAGES.TRANSLATION_LOCAL_LIMIT}{" "}
            <button
              type="button"
              aria-busy={(busy && action.what === "check") || undefined}
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) void checkAgain();
              }}
            >
              {SETTINGS.checkAgain}
            </button>
          </p>
        ) : null}
        <div role="status">
          {action.kind === "withdrawn" ? <p>{SETTINGS.afterWithdrawal}</p> : null}
          {/* "Try again" only while there is still a Withdraw to press. */}
          {action.kind === "failed" && (action.what === "check" || allowed) ? (
            <p>{action.message}</p>
          ) : null}
        </div>
      </section>
      <section aria-label="What is sent">
        <ul>
          {SETTINGS.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p>
          {SETTINGS.links.map((link, i) => (
            <span key={link.href}>
              {i > 0 ? " · " : null}
              <a href={link.href} target="_blank" rel="noopener noreferrer">
                {link.text}
              </a>
            </span>
          ))}
        </p>
      </section>
    </article>
  );
}
