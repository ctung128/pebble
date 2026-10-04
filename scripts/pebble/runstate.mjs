// `<data>/run/pebble.json`: what `pebble:start` launched, so `pebble:stop` can find exactly it.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runStatePath } from "./paths.mjs";

const INSTANCE_ID = /^[0-9a-f]{32}$/;
const isPid = (value) => Number.isInteger(value) && value > 1;
const isPort = (value) => Number.isInteger(value) && value > 0 && value < 65536;

/** The run state, or null when there is none or it isn't one Pebble wrote. */
export function readRunState(env) {
  let data;
  try {
    data = JSON.parse(readFileSync(runStatePath(env), "utf8"));
  } catch {
    return null;
  }
  const valid =
    data &&
    INSTANCE_ID.test(data.instanceId) &&
    isPid(data.launcherPid) &&
    isPid(data.worker?.pid) &&
    isPort(data.worker?.port) &&
    typeof data.worker?.version === "string" &&
    isPid(data.web?.pid) &&
    isPort(data.web?.port) &&
    typeof data.startedAt === "string";
  return valid ? data : null;
}

export function writeRunState(env, state) {
  const file = runStatePath(env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
}

/** Removes the run state, but only if it still belongs to `instanceId` (when given). */
export function removeRunState(env, instanceId) {
  const file = runStatePath(env);
  if (instanceId !== undefined) {
    const current = readRunState(env);
    if (current && current.instanceId !== instanceId) return false;
  }
  rmSync(file, { force: true });
  return true;
}
