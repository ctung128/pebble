// `npm run pebble:start`: the worker (FunASR) and the local app, in the foreground. Prints the
// URL once the worker answers and the app is served; the app shows when models are ready.
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { SETUP_CHECKS, collectChecks } from "./checks.mjs";
import { START } from "./copy.mjs";
import {
  VITE_BIN,
  WEB_DIR,
  WEB_PORT,
  WORKER_BIN,
  display,
  startLogPath,
  workerVersion,
} from "./paths.mjs";
import { WEB_HOST, isPebblePage, parsePebbleHealth } from "./ports.mjs";
import { removeRunState, writeRunState } from "./runstate.mjs";

const READY_TIMEOUT_MS = 60_000;
const POLL_MS = 250;
/** Longer than the worker's own bounded shutdown (it waits up to 10 s for a running job step). */
const STOP_TIMEOUT_MS = 20_000;

/** Credentials only the worker may hold (ADR 0008); never passed to the web server. */
export const WORKER_ONLY_ENV = ["DEEPL_AUTH_KEY"];

/** A copy of `env` for the web server, without worker-only credentials. */
export function webEnv(env) {
  const copy = { ...env };
  for (const name of WORKER_ONLY_ENV) delete copy[name];
  return copy;
}

export async function start(sys, { readyTimeoutMs = READY_TIMEOUT_MS } = {}) {
  const { checks, info } = await collectChecks(sys);
  const blocker = checks.find((c) => SETUP_CHECKS.includes(c.id) && !c.ok);
  if (blocker) {
    sys.print(START.notReady(`${blocker.label.toLowerCase()} ${blocker.detail}`, blocker.next));
    return 1;
  }
  const portCheck = checks.find((c) => c.id === "workerPort");
  if (info.port === null) {
    sys.print(portCheck.detail);
    return 1;
  }
  const port = info.port;
  switch (info.workerPortState.state) {
    case "pebble":
      sys.print(START.alreadyRunning(port));
      return 0;
    case "pebble-incompatible":
      sys.print(START.incompatible(port));
      return 1;
    case "other":
      sys.print(START.otherProgram(port));
      return 1;
  }
  if (info.webPortState !== "free") {
    sys.print(info.webPortState === "pebble" ? START.webBusyPebble : START.webBusyOther);
    return 1;
  }

  // Ctrl+C at any point from here on stops what was started, cleanly.
  let interrupted = false;
  let onInterrupt = () => {
    interrupted = true;
  };
  sys.onSignals(() => onInterrupt());

  sys.print(START.launching);
  const env = sys.env;
  const version = workerVersion();
  const instanceId = sys.randomId();
  const logFile = startLogPath(env);
  mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const log = openSync(logFile, "a", 0o600);
  const stdio = ["ignore", log, log];
  const worker = sys.spawn(WORKER_BIN, ["serve"], {
    env: {
      ...env,
      PEBBLE_PROVIDER: "funasr",
      PEBBLE_PORT: String(port),
      PEBBLE_INSTANCE_ID: instanceId,
    },
    stdio,
  });
  const web = sys.spawn(VITE_BIN, ["--port", String(WEB_PORT), "--strictPort"], {
    cwd: WEB_DIR,
    env: {
      ...webEnv(env),
      VITE_PEBBLE_MODE: "local",
      VITE_PEBBLE_WORKER_URL: `http://127.0.0.1:${port}`,
    },
    stdio,
  });
  closeSync(log);
  writeRunState(env, {
    instanceId,
    startedAt: new Date().toISOString(),
    launcherPid: process.pid,
    worker: { pid: worker.pid, port, version },
    web: { pid: web.pid, port: WEB_PORT },
  });

  const exited = new Set();
  worker.on("exit", () => exited.add("worker"));
  web.on("exit", () => exited.add("web"));

  const shutdown = async () => {
    for (const child of [worker, web]) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (exited.size < 2 && Date.now() < deadline) await sys.sleep(POLL_MS);
    removeRunState(env, instanceId);
  };

  // Ready = the worker answers /health with this run's instanceId, and the app is served.
  const deadline = Date.now() + readyTimeoutMs;
  let ready = false;
  while (!ready && !interrupted && Date.now() < deadline && exited.size === 0) {
    const health = await sys.httpGet(port, "/health");
    const ours = health && parsePebbleHealth(health.body)?.instanceId === instanceId;
    const page = ours ? await sys.httpGet(WEB_PORT, "/", { host: WEB_HOST }) : null;
    ready = Boolean(ours && page && isPebblePage(page.body));
    if (!ready) await sys.sleep(POLL_MS);
  }
  if (interrupted) {
    await shutdown();
    sys.print(START.stopped);
    return 0;
  }
  if (!ready) {
    await shutdown();
    sys.print(START.failed(display(logFile)));
    return 1;
  }

  sys.print(START.starting);
  sys.print(START.modelsNote);
  sys.print(START.howToStop);
  sys.print(START.logAt(display(logFile)));

  // A clean exit (0, or ended by a signal such as pebble:stop's SIGTERM or Ctrl+C) is a stop.
  const clean = (child) => child.signalCode !== null || child.exitCode === 0;
  const reason = await new Promise((resolve) => {
    const settle = (name, child) => resolve(clean(child) ? "stopped" : name);
    onInterrupt = () => resolve("signal");
    for (const [name, child] of [
      ["worker", worker],
      ["web", web],
    ]) {
      if (exited.has(name)) settle(name, child);
      else child.on("exit", () => settle(name, child));
    }
  });
  await shutdown();
  if (reason === "worker" || reason === "web") {
    sys.print(START.workerExited(display(logFile)));
    return 1;
  }
  sys.print(START.stopped);
  return 0;
}
