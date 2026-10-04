// Every tester-facing sentence for `npm run pebble:*`, in one place. Plain language; each
// problem gets exactly one next step.
import { MIN_NODE_MAJOR, WEB_PORT, WEB_URL } from "./paths.mjs";

export const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;

export const NEXT = {
  node: `Install Node.js ${MIN_NODE_MAJOR} or newer yourself, from https://nodejs.org.`,
  uv: "Install uv yourself, for example: brew install uv",
  ffmpeg: "Install FFmpeg yourself, for example: brew install ffmpeg",
  setup: "Run npm run pebble:setup.",
  verify: "Run npm run pebble:doctor -- --verify.",
  dataDir: (dir) => `Make sure you own ${dir} and can write to it.`,
  dataDirPrivate: (dir) => `Make it private to you: chmod 700 ${dir}`,
  disk: (bytes) => `Free up at least ${gb(bytes)} of disk space.`,
  stop: "Stop it with npm run pebble:stop.",
  otherPort: (port) => `Start Pebble on another port: PEBBLE_PORT=${port + 1} npm run pebble:start`,
  webPort: `Close the program using port ${WEB_PORT} (Pebble's app needs it), then try again.`,
};

export const DOCTOR = {
  title: (verify) =>
    verify
      ? "Pebble doctor — full check (read-only: nothing is changed)"
      : "Pebble doctor (read-only: nothing is changed)",
  integrityNotRun:
    "Model integrity: sizes match, but the full checksum check hasn't run. Run npm run pebble:doctor -- --verify to check every file.",
  verifying: "Checking every speech model file (this takes a few seconds)…",
  allReady: "Everything is ready. Start Pebble with: npm run pebble:start",
  problems: (n) => `${n} ${n === 1 ? "item needs" : "items need"} attention.`,
};

export const SETUP = {
  title: "Pebble setup. Pebble asks before it changes anything on this computer.",
  systemFirst:
    "Pebble can't install these for you. Install them yourself, then run npm run pebble:setup again:",
  nothingChanged: "Nothing was changed. You can run npm run pebble:setup again when you're ready.",
  noFurtherChanges:
    "No further changes were made. You can resume setup later with npm run pebble:setup.",
  notInteractive:
    "Setup needs to ask before it changes anything, so run it in a terminal window: npm run pebble:setup",
  confirmWebPackages: (size) =>
    [
      "Pebble's app needs its JavaScript packages.",
      `This will create the node_modules folder inside this Pebble folder (about ${size}), using`,
      "npm ci. Nothing is installed system-wide.",
      "Install them now?",
    ].join("\n"),
  confirmEnvironment: ({ size, pythonDownload, cacheDir, pythonDir }) =>
    [
      "Pebble's speech recognition needs a private Python environment.",
      `This will create services/worker/.venv inside this Pebble folder (about ${size}) and keep`,
      `the downloaded packages in ${cacheDir}. Nothing is installed system-wide.`,
      ...(pythonDownload
        ? [`uv will also download Python 3.12 into ${pythonDir}, because no Python 3.12 was found.`]
        : []),
      "Create it now?",
    ].join("\n"),
  confirmModels: ({ size, location }) =>
    [
      `Pebble needs to download its speech models once: about ${size}, saved to ${location}.`,
      "They run only on this computer. No audio ever leaves it.",
      "You can stop the download with Ctrl+C. Running npm run pebble:setup again keeps any model",
      "that finished and checked out, and downloads any unfinished model again.",
      "Download now?",
    ].join("\n"),
  confirmRedownload: ({ location }) =>
    [
      `Some speech model files in ${location} don't match their checksums.`,
      "This will download the affected models again and replace those files.",
      "Download them again now?",
    ].join("\n"),
  diskShort: (needed, free) =>
    `This step needs about ${gb(needed)} of free disk space, but only ${gb(free)} is free. Free up some space, then run npm run pebble:setup again.`,
  stepFailed: (what) =>
    `${what} didn't finish. The details are above. You can resume setup later with npm run pebble:setup.`,
  verifying: DOCTOR.verifying,
  complete: "Setup complete. Start Pebble with: npm run pebble:start",
};

export const START = {
  notReady: (label, next) => `Pebble isn't set up yet: ${label}. ${next}`,
  alreadyRunning: (port) =>
    [
      `Pebble is already running (worker on port ${port}).`,
      `Open ${WEB_URL}. To restart it, stop it first with npm run pebble:stop (or Ctrl+C in its terminal).`,
    ].join("\n"),
  incompatible: (port) =>
    `An older or differently configured Pebble worker is running on port ${port}. ${NEXT.stop}`,
  otherProgram: (port) =>
    `Port ${port} is used by another program, and Pebble won't touch it. ${NEXT.otherPort(port)}`,
  webBusyPebble: `Pebble's app is already being served on port ${WEB_PORT} by another window. Stop it there (Ctrl+C), then run npm run pebble:start again.`,
  webBusyOther: `Port ${WEB_PORT} is used by another program, and Pebble won't touch it. ${NEXT.webPort}`,
  launching: "Starting Pebble…",
  starting: `Pebble is starting: open ${WEB_URL}`,
  modelsNote: "The app will confirm when local speech models are ready.",
  howToStop: "Press Ctrl+C here to stop Pebble.",
  logAt: (log) => `Technical log: ${log}`,
  failed: (log) => `Pebble couldn't start. The details are in ${log}.`,
  stopped: "Pebble stopped.",
  workerExited: (log) => `Pebble's worker stopped unexpectedly. The details are in ${log}.`,
};

export const STOP = {
  notRunning: "Pebble isn't running. Nothing was stopped.",
  notOurs: (port) =>
    `A Pebble worker is running on port ${port}, but it wasn't started with npm run pebble:start, so Pebble won't stop it. Stop it with Ctrl+C in its terminal.`,
  stale:
    "The last Pebble start is no longer running, so its run record was removed. Nothing was stopped.",
  staleReused:
    "The last Pebble start is no longer running (its process number now belongs to another program, which was left alone), so its run record was removed. Nothing was stopped.",
  unidentified: (port) =>
    `The process from the last start doesn't answer as that Pebble worker on port ${port}, so Pebble won't stop it. Nothing was stopped.`,
  stopping: (port) => `Stopping Pebble (worker on port ${port})…`,
  stopped: "Pebble stopped.",
  waiting: "Waiting for Pebble to finish the step it's on (up to 20 seconds)…",
  stillRunning: (seconds) =>
    `Pebble's worker didn't stop within ${seconds} seconds and was left running. Try npm run pebble:stop again, or press Ctrl+C where Pebble is running.`,
};
