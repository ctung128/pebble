// The checks behind `pebble:doctor`, `pebble:setup` and `pebble:start`. Read-only: they run
// version commands and `pebble-worker check` (which changes nothing) and probe local ports.
import path from "node:path";
import { NEXT, gb } from "./copy.mjs";
import {
  MIN_NODE_MAJOR,
  REPO,
  VITE_BIN,
  WEB_PORT,
  WORKER_BIN,
  dataDir,
  display,
  workerPort,
  workerVersion,
} from "./paths.mjs";

/** Roughly what setup still needs on disk, beyond the models (measured on macOS arm64). */
export const ENVIRONMENT_BYTES = 2.0e9; // .venv ≈ 1.0 GB plus uv's download cache
export const WEB_PACKAGES_BYTES = 0.2e9;
const MARGIN_BYTES = 0.5e9;
/** Checks whose failure means setup isn't finished (ports and disk are reported separately). */
export const SETUP_CHECKS = [
  "node",
  "uv",
  "ffmpeg",
  "ffprobe",
  "webPackages",
  "environment",
  "dataDir",
  "models",
];
export const SYSTEM_CHECKS = ["node", "uv", "ffmpeg", "ffprobe"];

function firstLine(text) {
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

/** `pebble-worker check --json` from the existing environment; null when it can't run. */
export function workerCheck(sys, { verify = false } = {}) {
  if (!sys.exists(WORKER_BIN)) return null;
  const result = sys.run(WORKER_BIN, ["check", "--json", ...(verify ? ["--verify"] : [])], {
    env: { ...sys.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

/**
 * Every check as `{ id, label, ok, detail, next }`; `next` (one plain step) is set exactly
 * when `ok` is false. `info` carries the facts setup and start act on.
 */
export async function collectChecks(sys, { verify = false } = {}) {
  const checks = [];
  const add = (id, label, ok, detail, next = null) =>
    checks.push({ id, label, ok, detail, next: ok ? null : next });

  const major = Number(sys.nodeVersion.split(".")[0]);
  add("node", "Node.js", major >= MIN_NODE_MAJOR, `v${sys.nodeVersion}`, NEXT.node);

  const uv = sys.run("uv", ["--version"]);
  add("uv", "uv", uv.code === 0, uv.code === 0 ? firstLine(uv.stdout) : "not found", NEXT.uv);

  for (const tool of ["ffmpeg", "ffprobe"]) {
    const result = sys.run(tool, ["-version"]);
    const found = result.code === 0;
    const version = found ? firstLine(result.stdout).replace(/ Copyright.*$/, "") : "not found";
    add(tool, tool === "ffmpeg" ? "FFmpeg" : "ffprobe", found, version, NEXT.ffmpeg);
  }

  const webPackages = sys.exists(VITE_BIN);
  add(
    "webPackages",
    "App packages",
    webPackages,
    webPackages ? "installed" : "not installed",
    NEXT.setup,
  );

  const data = dataDir(sys.env);
  const report = workerCheck(sys, { verify });
  const environment = Boolean(report?.environment?.ok);
  add(
    "environment",
    "Speech environment",
    environment,
    environment ? "installed" : sys.exists(WORKER_BIN) ? "incomplete" : "not set up",
    NEXT.setup,
  );

  const dir = report?.dataDir;
  const dirOk = !dir || !dir.exists || (dir.private && dir.writable);
  add(
    "dataDir",
    "Data folder",
    dirOk,
    !dir
      ? display(data)
      : dir.exists
        ? `${dir.path} (${dir.private ? "private" : "not private"}, ${dir.writable ? "writable" : "not writable"})`
        : `${dir.path} (created on first start)`,
    dir?.exists && dir.writable && !dir.private
      ? NEXT.dataDirPrivate(display(data))
      : NEXT.dataDir(display(data)),
  );

  const models = report?.models;
  let modelDetail = "can't check until the speech environment is set up";
  let modelsOk = false;
  let modelNext = NEXT.setup;
  if (models) {
    const size = gb(models.requiredBytes);
    modelsOk = models.state === "present" || models.state === "verified";
    modelDetail = {
      missing: `not downloaded (about ${size})`,
      incomplete: `incomplete (${models.present} of ${models.files} files)`,
      wrong_size: `${models.wrongSize} file(s) have the wrong size`,
      present: `all ${models.files} files present; sizes match`,
      verified: `all ${models.files} files verified`,
      failed: "some files don't match their checksums",
    }[models.state];
  }
  add("models", "Speech models", modelsOk, modelDetail, modelNext);

  const free = sys.freeBytes(data);
  const missingModelBytes = models ? models.requiredBytes - models.presentBytes : 1.3e9;
  const needed =
    (webPackages ? 0 : WEB_PACKAGES_BYTES) +
    (environment ? 0 : ENVIRONMENT_BYTES) +
    (modelsOk ? 0 : missingModelBytes);
  const diskOk = needed === 0 || free >= needed + MARGIN_BYTES;
  add(
    "disk",
    "Disk space",
    diskOk,
    `${gb(free)} free${needed ? `; setup needs about ${gb(needed)}` : ""}`,
    NEXT.disk(needed + MARGIN_BYTES),
  );

  let port;
  try {
    port = workerPort(sys.env);
  } catch (error) {
    add("workerPort", "Worker port", false, error.message, "Unset PEBBLE_PORT or fix its value.");
    port = null;
  }
  let workerPortState = null;
  if (port !== null) {
    workerPortState = await sys.classifyWorkerPort(port, { expectedVersion: workerVersion() });
    const detail = {
      free: `${port} is free`,
      pebble: `Pebble is running on ${port}`,
      "pebble-incompatible": `an older or differently configured Pebble worker is on ${port}`,
      other: `${port} is used by another program`,
    }[workerPortState.state];
    const next = workerPortState.state === "other" ? NEXT.otherPort(port) : NEXT.stop;
    add(
      "workerPort",
      "Worker port",
      workerPortState.state === "free" || workerPortState.state === "pebble",
      detail,
      next,
    );
  }

  const web = await sys.classifyWebPort(WEB_PORT);
  add(
    "webPort",
    "App port",
    web.state !== "other",
    {
      free: `${WEB_PORT} is free`,
      pebble: `Pebble's app is on ${WEB_PORT}`,
      other: `${WEB_PORT} is used by another program`,
    }[web.state],
    NEXT.webPort,
  );

  return {
    checks,
    info: {
      dataDir: data,
      port,
      workerPortState,
      webPortState: web.state,
      models,
      free,
      verified: models?.verified ?? null,
      pythonEnvironment: path.relative(REPO, WORKER_BIN),
    },
  };
}

export const byId = (checks, id) => checks.find((check) => check.id === id);
