// Test helpers for scripts/pebble (not a test file itself). Fakes never touch the real
// ~/.pebble, install anything, download anything or reach the network.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { VITE_BIN, WORKER_BIN } from "./paths.mjs";

export const VERSION = "0.1.0";
export const INSTANCE = "0123456789abcdef0123456789abcdef";

export function tempDataDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "pebble-scripts-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function workerReport(overrides = {}) {
  return {
    python: { version: "3.12.3", ok: true },
    ffmpeg: { ok: true, version: "9.0" },
    ffprobe: { ok: true, version: "9.0" },
    dataDir: { path: "~/.pebble-test", exists: true, private: true, writable: true },
    environment: { ok: true, runtime: { funasr: "1.4.16" } },
    models: {
      state: "present",
      files: 14,
      present: 14,
      missing: 0,
      wrongSize: 0,
      requiredBytes: 1_296_079_251,
      presentBytes: 1_296_079_251,
      verified: null,
      location: "~/.pebble-test/models",
    },
    disk: { freeBytes: 100e9 },
    ...overrides,
  };
}

export const health = (overrides = {}) => ({
  schemaVersion: "1.6",
  workerVersion: VERSION,
  status: "ok",
  dataDirWritable: true,
  tools: { ffmpeg: { available: true, version: "9" }, ffprobe: { available: true, version: "9" } },
  providers: [{ id: "funasr", kind: "asr", available: false, detail: null, state: "checking" }],
  ...overrides,
});

/** Rejects printing a missing message (an undefined copy key would otherwise print blank). */
export function checkedLine(args) {
  if (args.length && typeof args[0] !== "string") throw new Error(`printed ${String(args[0])}`);
  return args[0] ?? "";
}

/**
 * A fake system. `state` controls what exists and what commands report; `calls` records every
 * command run, so tests can assert that nothing was installed or downloaded.
 */
export function fakeSystem({
  dataDir,
  tools = { uv: true, ffmpeg: true, ffprobe: true },
  webPackages = true,
  environment = true,
  report = () => workerReport(),
  answers = [],
  isTTY = true,
  workerPort = { state: "free" },
  webPort = { state: "free" },
  free = 100e9,
  env = {},
  onRun = () => null,
} = {}) {
  const calls = [];
  const output = [];
  const prompts = [];
  const state = { webPackages, environment };
  const sys = {
    env: { PEBBLE_DATA_DIR: dataDir, ...env },
    nodeVersion: "22.15.1",
    isTTY,
    print: (...args) => output.push(checkedLine(args)),
    run: (command, args, options = {}) => {
      calls.push({ command, args, options });
      const custom = onRun(command, args, state);
      if (custom) return custom;
      const name = path.basename(command);
      if (["uv", "ffmpeg", "ffprobe"].includes(name) && args[0].includes("version")) {
        return tools[name]
          ? { code: 0, stdout: `${name} version 9.0 Copyright x\n`, stderr: "" }
          : { code: 127, stdout: "", stderr: "not found" };
      }
      if (command === WORKER_BIN && args[0] === "check") {
        return { code: 0, stdout: JSON.stringify(report(args.includes("--verify"), state)) };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    exists: (p) =>
      p === VITE_BIN ? state.webPackages : p === WORKER_BIN ? state.environment : false,
    freeBytes: () => free,
    confirm: async (question) => {
      prompts.push(question);
      return answers.shift() ?? false;
    },
    spawn: () => {
      throw new Error("spawn not expected");
    },
    kill: () => {
      throw new Error("kill not expected");
    },
    isAlive: () => false,
    randomId: () => INSTANCE,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    httpGet: async () => null,
    classifyWorkerPort: async () => workerPort,
    classifyWebPort: async () => webPort,
    onSignals: () => {},
  };
  return { sys, calls, output, prompts, state, text: () => output.join("\n") };
}

/** A fake child process. */
export function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    child.signalCode = signal;
    setImmediate(() => child.emit("exit", null, signal));
  };
  return child;
}

/** A real HTTP server on 127.0.0.1 answering `/health` and `/`; `.port`, `.close()`. */
export async function serve({ healthBody, pageBody = "<title>Pebble</title>" } = {}) {
  const server = http.createServer((request, response) => {
    if (request.url === "/health" && healthBody !== undefined) {
      response.setHeader("content-type", "application/json");
      response.end(typeof healthBody === "string" ? healthBody : JSON.stringify(healthBody));
    } else {
      response.end(pageBody);
    }
  });
  // A listen failure rejects (a throw, or an "error" event), so callers' cleanup can run.
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
