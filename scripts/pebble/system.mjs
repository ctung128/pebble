// The real side effects behind `npm run pebble:*`, behind one object so tests can replace them.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statfsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { classifyWebPort, classifyWorkerPort, httpGet } from "./ports.mjs";

/** Free bytes on the volume holding `target` (or its nearest existing parent). */
function freeBytes(target) {
  let current = target;
  while (!existsSync(current) && current !== path.dirname(current)) current = path.dirname(current);
  const stats = statfsSync(current);
  return stats.bavail * stats.bsize;
}

function run(command, args, { env = process.env, cwd, inherit = false } = {}) {
  const result = spawnSync(command, args, {
    env,
    cwd,
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) return { code: 127, stdout: "", stderr: String(result.error.message) };
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function realSystem() {
  return {
    env: process.env,
    nodeVersion: process.versions.node,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    print: (line = "") => console.log(line),
    run,
    exists: existsSync,
    freeBytes,
    confirm,
    spawn,
    kill: (pid, signal) => process.kill(pid, signal),
    isAlive,
    randomId: () => randomBytes(16).toString("hex"),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    httpGet,
    classifyWorkerPort,
    classifyWebPort,
    onSignals: (handler) => {
      process.on("SIGINT", handler);
      process.on("SIGTERM", handler);
    },
  };
}
