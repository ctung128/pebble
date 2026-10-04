// Where things are. Pebble's own data lives under PEBBLE_DATA_DIR (default ~/.pebble).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const WORKER_DIR = path.join(REPO, "services", "worker");
export const WORKER_BIN = path.join(WORKER_DIR, ".venv", "bin", "pebble-worker");
export const WEB_DIR = path.join(REPO, "apps", "web");
export const VITE_BIN = path.join(REPO, "node_modules", ".bin", "vite");
export const DEFAULT_WORKER_PORT = 8790;
/** Fixed in Slice 1: the worker's allowed origins include it. */
export const WEB_PORT = 5175;
export const WEB_URL = `http://localhost:${WEB_PORT}`;
export const MIN_NODE_MAJOR = 22;

export function dataDir(env) {
  const raw = env.PEBBLE_DATA_DIR;
  if (!raw) return path.join(homedir(), ".pebble");
  return path.resolve(raw.replace(/^~(?=$|\/)/, homedir()));
}

export const runStatePath = (env) => path.join(dataDir(env), "run", "pebble.json");
export const startLogPath = (env) => path.join(dataDir(env), "logs", "pebble-start.log");

/** `/Users/me/.pebble` → `~/.pebble`. */
export function display(p) {
  const home = homedir();
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

export function workerPort(env) {
  const raw = env.PEBBLE_PORT;
  if (raw === undefined || raw === "") return DEFAULT_WORKER_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === WEB_PORT) {
    throw new Error(`PEBBLE_PORT must be a number from 1024 to 65535 (not ${WEB_PORT}).`);
  }
  return port;
}

/** The worker version this checkout runs (services/worker/pyproject.toml). */
export function workerVersion() {
  const text = readFileSync(path.join(WORKER_DIR, "pyproject.toml"), "utf8");
  const match = /^version\s*=\s*"([^"]+)"/m.exec(text);
  if (!match) throw new Error("Couldn't read the worker version.");
  return match[1];
}
