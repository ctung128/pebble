// `npm run pebble:stop`: stops only the worker `pebble:start` launched. The trust signal is the
// run's instanceId: the run state and the worker's own /health must agree on it (plus PID,
// port and version). `ps` is a best-effort extra check. Nothing is ever force-killed.
import { STOP } from "./copy.mjs";
import { WEB_PORT, workerPort, workerVersion } from "./paths.mjs";
import { WEB_HOST, isPebblePage, parsePebbleHealth } from "./ports.mjs";
import { readRunState, removeRunState } from "./runstate.mjs";

/** Longer than the worker's own bounded shutdown (it waits up to 10 s for a running job step). */
const STOP_TIMEOUT_MS = 20_000;
const POLL_MS = 250;

function commandOf(sys, pid) {
  const result = sys.run("ps", ["-o", "command=", "-p", String(pid)]);
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function stop(sys, { timeoutMs = STOP_TIMEOUT_MS } = {}) {
  const state = readRunState(sys.env);
  if (!state) {
    const port = workerPort(sys.env);
    const found = await sys.classifyWorkerPort(port, { expectedVersion: workerVersion() });
    const pebble = found.state === "pebble" || found.state === "pebble-incompatible";
    sys.print(pebble ? STOP.notOurs(port) : STOP.notRunning);
    return 0;
  }
  const { instanceId, worker } = state;
  const response = await sys.httpGet(worker.port, "/health");
  const health = response ? parsePebbleHealth(response.body) : null;
  const ours = health?.instanceId === instanceId;

  if (!sys.isAlive(worker.pid)) {
    if (!ours) {
      removeRunState(sys.env, instanceId);
      sys.print(STOP.stale);
      return 0;
    }
    sys.print(STOP.unidentified(worker.port)); // the recorded PID is gone yet the run answers
    return 1;
  }
  const command = commandOf(sys, worker.pid);
  const identified =
    ours &&
    health.workerVersion === worker.version &&
    (command === null || command.includes("pebble-worker"));
  if (!identified) {
    if (!ours && !health) {
      // The recorded PID belongs to something else now and no worker answers: a stale record.
      removeRunState(sys.env, instanceId);
      sys.print(STOP.staleReused);
      return 0;
    }
    sys.print(STOP.unidentified(worker.port));
    return 1;
  }

  sys.print(STOP.stopping(worker.port));
  sys.kill(worker.pid, "SIGTERM");
  const started = Date.now();
  let told = false;
  while (sys.isAlive(worker.pid) && Date.now() < started + timeoutMs) {
    if (!told && Date.now() - started > 2_000) {
      sys.print(STOP.waiting);
      told = true;
    }
    await sys.sleep(POLL_MS);
  }
  if (sys.isAlive(worker.pid)) {
    sys.print(STOP.stillRunning(Math.round(timeoutMs / 1000)));
    return 1;
  }

  // The launcher stops the app and removes the run state when its worker exits. If the
  // launcher itself is gone, stop the app only if it is still the Pebble app on its port.
  if (!sys.isAlive(state.launcherPid) && sys.isAlive(state.web.pid)) {
    const page = await sys.httpGet(WEB_PORT, "/", { host: WEB_HOST });
    const webCommand = commandOf(sys, state.web.pid);
    if (page && isPebblePage(page.body) && webCommand?.includes("vite")) {
      sys.kill(state.web.pid, "SIGTERM");
    }
  }
  const cleanup = Date.now() + 5_000;
  while (readRunState(sys.env)?.instanceId === instanceId && Date.now() < cleanup) {
    if (!sys.isAlive(state.launcherPid)) break;
    await sys.sleep(POLL_MS);
  }
  removeRunState(sys.env, instanceId);
  sys.print(STOP.stopped);
  return 0;
}
