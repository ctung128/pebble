import styles from "./StatusView.module.css";

interface StatusViewProps {
  kind: "loading" | "error" | "empty";
  title: string;
  message?: string;
  onRetry?: () => void;
}

export function StatusView({ kind, title, message, onRetry }: StatusViewProps) {
  return (
    <div className={styles.status} data-kind={kind} role={kind === "error" ? "alert" : "status"}>
      {kind === "loading" ? <span className={styles.spinner} aria-hidden="true" /> : null}
      <p className={styles.title}>{title}</p>
      {message ? <p className={styles.message}>{message}</p> : null}
      {onRetry ? (
        <button type="button" className={styles.retry} onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
