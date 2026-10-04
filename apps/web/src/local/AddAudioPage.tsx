import { useId, useRef, useState, type FormEvent } from "react";
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
  | { kind: "error"; message: string; hint: string | null };

const UPLOAD_ERRORS: Record<string, string> = {
  UNREACHABLE:
    "Pebble's local worker stopped responding. Start it with npm run worker, then try again.",
  FILE_TOO_LARGE: "This file is larger than the worker's upload limit.",
  UNSUPPORTED_MEDIA: "The worker doesn't accept this file type.",
  EMPTY_FILE: "This file is empty.",
  STORAGE_ERROR: "The worker couldn't save the file. Check free disk space.",
  ORIGIN_NOT_ALLOWED:
    "The worker didn't accept this page. Open local mode at http://localhost:5175.",
};

export function AddAudioPage() {
  const { client, status, mode, recheck } = useWorker();
  const copy = LOCAL_COPY[mode ?? "mock"];
  const navigate = useNavigate();
  const ids = { file: useId(), title: useId(), owner: useId(), errors: useId() };

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [titleEdited, setTitleEdited] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [upload, setUpload] = useState<UploadState>({ kind: "idle" });
  // A ref, not state: blocks a second submit even within the same event loop turn.
  const submitting = useRef(false);

  const problems = {
    file: file ? fileProblem(file) : "Choose an audio file.",
    title: titleProblem(title),
    owner: confirmed ? null : "Confirm that you own this audio or are authorized to process it.",
  };
  const valid = !problems.file && !problems.title && !problems.owner;
  const busy = upload.kind === "uploading";

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
      navigate(`/jobs/${job.id}`);
    } catch (error) {
      const worker = error instanceof WorkerError ? error : null;
      setUpload({
        kind: "error",
        message:
          (worker && UPLOAD_ERRORS[worker.code]) ?? worker?.message ?? "The upload didn't finish.",
        hint: worker?.hint ?? null,
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

      <WorkerStatusCard status={status} onRecheck={recheck} />

      {status.kind === "ready" ? (
        <form className={styles.form} onSubmit={submit} noValidate aria-describedby={ids.errors}>
          <div className={styles.field}>
            <label htmlFor={ids.file} className={styles.label}>
              Audio file
            </label>
            <input
              id={ids.file}
              type="file"
              accept={[...SUPPORTED_EXTENSIONS, "audio/*"].join(",")}
              disabled={busy}
              aria-invalid={showErrors && problems.file ? true : undefined}
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
              <p className={styles.fieldError}>{problems.file}</p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label htmlFor={ids.title} className={styles.label}>
              Title
            </label>
            <input
              id={ids.title}
              type="text"
              className={styles.input}
              value={title}
              maxLength={MAX_TITLE_LENGTH + 20}
              disabled={busy}
              aria-invalid={showErrors && problems.title ? true : undefined}
              onChange={(event) => {
                setTitle(event.target.value);
                setTitleEdited(true);
              }}
            />
            {showErrors && problems.title ? (
              <p className={styles.fieldError}>{problems.title}</p>
            ) : null}
          </div>

          <div className={styles.check}>
            <input
              id={ids.owner}
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              aria-invalid={showErrors && problems.owner ? true : undefined}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <label htmlFor={ids.owner}>{OWNERSHIP_LABEL}</label>
          </div>
          {showErrors && problems.owner ? (
            <p className={styles.fieldError}>{problems.owner}</p>
          ) : null}

          <p className={styles.privacy}>
            Your audio stays private on this computer. It's saved in Pebble's local data folder
            {status.health.dataDir ? (
              <>
                {" "}
                (<code>{status.health.dataDir.path}</code>)
              </>
            ) : null}{" "}
            and is never uploaded to the internet.
          </p>

          <div id={ids.errors} aria-live="polite">
            {upload.kind === "uploading" ? (
              <div className={styles.progress}>
                <label>
                  Sending to the local worker… {formatBytes(upload.loaded)} of{" "}
                  {formatBytes(upload.total)}
                  <progress max={upload.total} value={upload.loaded} />
                </label>
              </div>
            ) : null}
            {upload.kind === "error" ? (
              <div className={styles.formError} role="alert">
                <p>{upload.message}</p>
                {upload.hint ? <p className={styles.help}>{upload.hint}</p> : null}
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
