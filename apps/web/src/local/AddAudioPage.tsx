import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { WorkerError } from "./workerClient.ts";
import { LOCAL_COPY } from "./providerCopy.ts";
import { useWorker } from "./WorkerContext.tsx";
import { WorkerStatusCard } from "./WorkerStatusCard.tsx";
import {
  fileProblem,
  formatBytes,
  MAX_TITLE_LENGTH,
  SUPPORTED_EXTENSIONS,
  titleFromFilename,
  titleProblem,
} from "./uploadRules.ts";
import styles from "./local.module.css";

export const OWNERSHIP_LABEL =
  "I own this audio or am authorized to process it. Pebble processes it only on this computer.";

type UploadState =
  | { kind: "idle" }
  | { kind: "uploading"; loaded: number; total: number }
  | { kind: "error"; message: string };

/** Plain copy by error code. The worker's own message and hint are never shown. */
const UPLOAD_ERRORS: Record<string, string> = {
  UNREACHABLE: "Pebble isn't responding. Check that it's running, then try again.",
  FILE_TOO_LARGE: "This file is too large. Pebble accepts files up to 2 GB.",
  UNSUPPORTED_MEDIA: "This file type isn't supported. Try an MP3, M4A or WAV file.",
  EMPTY_FILE: "This file is empty.",
  STORAGE_ERROR: "Pebble couldn't save the file. Check that there's free disk space.",
  ORIGIN_NOT_ALLOWED:
    "Pebble can't accept uploads from this page. Open Pebble from the address it gives you when it starts.",
};
const UPLOAD_FAILED = "The upload didn't finish. Try again.";

export function AddAudioPage() {
  const { client, status, mode, recheck } = useWorker();
  const copy = LOCAL_COPY[mode ?? "mock"];
  const navigate = useNavigate();
  const ids = {
    file: useId(),
    title: useId(),
    owner: useId(),
    fileError: useId(),
    titleError: useId(),
    ownerError: useId(),
    errors: useId(),
  };

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [titleEdited, setTitleEdited] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [upload, setUpload] = useState<UploadState>({ kind: "idle" });
  // A ref, not state: blocks a second submit even within the same event loop turn.
  const submitting = useRef(false);
  // Whether the learner is still on this page when the upload finishes.
  const onPage = useRef(true);
  useEffect(() => {
    onPage.current = true;
    return () => {
      onPage.current = false;
    };
  }, []);

  const problems = {
    file: file ? fileProblem(file) : "Choose an audio file.",
    title: titleProblem(title),
    owner: confirmed ? null : "Confirm that you own this audio or are authorized to process it.",
  };
  const valid = !problems.file && !problems.title && !problems.owner;
  const busy = upload.kind === "uploading";

  // Closing or reloading the tab mid-send loses the upload (Pebble never receives the file),
  // so the browser asks first, but only while sending. Moving to another Pebble page is fine.
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = ""; // older browsers need it set to show the prompt
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setShowErrors(true);
    if (!valid || !file || submitting.current) return;
    submitting.current = true;
    setUpload({ kind: "uploading", loaded: 0, total: file.size });
    try {
      const job = await client.upload({
        file,
        title: title.trim(),
        ownershipConfirmed: true,
        onProgress: ({ loaded, total }) => setUpload({ kind: "uploading", loaded, total }),
      });
      // If the learner moved on to another page, the new job simply appears in the Library.
      if (onPage.current) navigate(`/jobs/${job.id}`);
    } catch (error) {
      const worker = error instanceof WorkerError ? error : null;
      setUpload({
        kind: "error",
        message: (worker && UPLOAD_ERRORS[worker.code]) ?? UPLOAD_FAILED,
      });
      if (worker?.code === "UNREACHABLE") recheck();
    } finally {
      submitting.current = false;
    }
  };

  return (
    <div className={styles.page}>
      <title>{`${copy.uploadHeading} · Pebble`}</title>
      <header className={styles.intro}>
        <h1 className={styles.heading}>{copy.uploadHeading}</h1>
        <p className={styles.lede}>{copy.uploadDescription}</p>
      </header>

      {/* Only when something needs doing; a ready Pebble just shows the form. */}
      <WorkerStatusCard status={status} onRecheck={recheck} showReady={false} />

      {status.kind === "ready" ? (
        <form className={styles.form} onSubmit={submit} noValidate aria-describedby={ids.errors}>
          <div className={styles.field}>
            <label htmlFor={ids.file} className={styles.label}>
              Audio file
            </label>
            <input
              id={ids.file}
              type="file"
              className={styles.fileInput}
              accept={[...SUPPORTED_EXTENSIONS, "audio/*"].join(",")}
              disabled={busy}
              aria-invalid={showErrors && problems.file ? true : undefined}
              aria-describedby={showErrors && problems.file ? ids.fileError : undefined}
              onChange={(event) => {
                const chosen = event.target.files?.[0] ?? null;
                setFile(chosen);
                if (chosen && !titleEdited) setTitle(titleFromFilename(chosen.name));
                setUpload({ kind: "idle" });
              }}
            />
            <p className={styles.help}>
              M4A, MP3, WAV, FLAC, OGG/Opus, WebM or AAC, up to 2 GB.
              {file ? ` Selected: ${file.name} (${formatBytes(file.size)}).` : ""}
            </p>
            {showErrors && problems.file ? (
              <p id={ids.fileError} className={styles.fieldError}>
                {problems.file}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label htmlFor={ids.title} className={styles.label}>
              Episode title
            </label>
            <input
              id={ids.title}
              type="text"
              className={styles.input}
              value={title}
              maxLength={MAX_TITLE_LENGTH + 20}
              disabled={busy}
              aria-invalid={showErrors && problems.title ? true : undefined}
              aria-describedby={showErrors && problems.title ? ids.titleError : undefined}
              onChange={(event) => {
                setTitle(event.target.value);
                setTitleEdited(true);
              }}
            />
            {showErrors && problems.title ? (
              <p id={ids.titleError} className={styles.fieldError}>
                {problems.title}
              </p>
            ) : null}
          </div>

          <div className={styles.check}>
            <input
              id={ids.owner}
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              aria-invalid={showErrors && problems.owner ? true : undefined}
              aria-describedby={showErrors && problems.owner ? ids.ownerError : undefined}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <label htmlFor={ids.owner}>{OWNERSHIP_LABEL}</label>
          </div>
          {showErrors && problems.owner ? (
            <p id={ids.ownerError} className={styles.fieldError}>
              {problems.owner}
            </p>
          ) : null}

          <div id={ids.errors} aria-live="polite">
            {upload.kind === "uploading" ? (
              <div className={styles.progress}>
                <label>
                  Sending your audio… {formatBytes(upload.loaded)} of {formatBytes(upload.total)}.
                  Keep this page open until your audio is sent.
                  <progress max={upload.total} value={upload.loaded} />
                </label>
              </div>
            ) : null}
            {upload.kind === "error" ? (
              <div className={styles.formError} role="alert">
                <p>{upload.message}</p>
              </div>
            ) : null}
          </div>

          <button type="submit" className={styles.primaryButton} disabled={busy} aria-busy={busy}>
            {busy ? "Sending…" : copy.submitLabel}
          </button>
        </form>
      ) : null}
    </div>
  );
}
