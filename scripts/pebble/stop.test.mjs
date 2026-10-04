// Real processes and real local listeners; the run state lives in a temporary data folder.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { workerVersion } from "./paths.mjs";
import { readRunState, writeRunState } from "./runstate.mjs";
import { stop } from "./stop.mjs";
import { realSystem } from "./system.mjs";
import { INSTANCE, checkedLine, health, serve, tempDataDir } from "./testkit.mjs";

const VERSION = workerVersion();

function system(dir, env = {}) {
  const output = [];
  const sys = {
    ...realSystem(),
    env: { PEBBLE_DATA_DIR: dir, ...env },
    print: (...args) => output.push(checkedLine(args)),
  };
  return { sys, text: () => output.join("\n") };
}

/** A long-running process whose command line contains `name`. */
function dummy(dir, name, { ignoreTerm = false } = {}) {
  const script = path.join(dir, `${name}.mjs`);
  writeFileSync(
    script,
    `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ""} setInterval(() => {}, 1000);`,
  );
  const child = spawn(process.execPath, [script], { stdio: "ignore" });
  return child;
}

async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.on("exit", resolve));
  return child.pid;
}

const alive = (pid) => realSystem().isAlive(pid);
const exited = (child) =>
  new Promise((resolve) =>
    child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", resolve),
  );

function record(dir, { pid, port, version = VERSION, launcherPid, webPid }) {
  writeRunState(
    { PEBBLE_DATA_DIR: dir },
    {
      instanceId: INSTANCE,
      startedAt: new Date().toISOString(),
      launcherPid,
      worker: { pid, port, version },
      web: { pid: webPid, port: 5175 },
    },
  );
}

test("nothing to stop when nothing is running", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const free = net.createServer();
    await new Promise((r) => free.listen(0, "127.0.0.1", r));
    const port = free.address().port;
    await new Promise((r) => free.close(r));
    const { sys, text } = system(dir, { PEBBLE_PORT: String(port) });
    assert.equal(await stop(sys), 0);
    assert.match(text(), /Pebble isn't running\. Nothing was stopped\./);
  } finally {
    cleanup();
  }
});

test("a Pebble worker started some other way is left alone", async () => {
  const { dir, cleanup } = tempDataDir();
  const server = await serve({ healthBody: health() });
  try {
    const { sys, text } = system(dir, { PEBBLE_PORT: String(server.port) });
    assert.equal(await stop(sys), 0);
    assert.match(text(), /wasn't started with npm run pebble:start, so Pebble won't stop it/);
  } finally {
    await server.close();
    cleanup();
  }
});

test("a stale run record is removed without signalling anything", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    record(dir, {
      pid: await deadPid(),
      port: 1,
      launcherPid: await deadPid(),
      webPid: await deadPid(),
    });
    const { sys, text } = system(dir);
    assert.equal(await stop(sys), 0);
    assert.match(text(), /no longer running, so its run record was removed/);
    assert.equal(readRunState(sys.env), null);
  } finally {
    cleanup();
  }
});

test("an unrelated listener holding the recorded PID is never killed", async () => {
  const { dir, cleanup } = tempDataDir();
  // A separate process listening on a port, not Pebble, not answering /health.
  const listener = spawn(
    process.execPath,
    [
      "-e",
      "require('net').createServer(s => s.resume()).listen(0, '127.0.0.1', function () { process.stdout.write(String(this.address().port)) })",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    const port = Number(
      await new Promise((r) => listener.stdout.once("data", (d) => r(String(d)))),
    );
    record(dir, { pid: listener.pid, port, launcherPid: await deadPid(), webPid: await deadPid() });
    const { sys, text } = system(dir);
    assert.equal(await stop(sys), 0);
    assert.ok(alive(listener.pid), "the unrelated process must survive");
    assert.match(text(), /belongs to another program, which was left alone/);
  } finally {
    listener.kill();
    await exited(listener);
    cleanup();
  }
});

test("a worker whose instanceId or version doesn't match is not stopped", async () => {
  const { dir, cleanup } = tempDataDir();
  const worker = dummy(dir, "pebble-worker-fake");
  try {
    for (const body of [
      health({ instanceId: "f".repeat(32) }),
      health({ instanceId: INSTANCE, workerVersion: "9.9.9" }),
    ]) {
      const server = await serve({ healthBody: body });
      record(dir, {
        pid: worker.pid,
        port: server.port,
        launcherPid: await deadPid(),
        webPid: await deadPid(),
      });
      const { sys, text } = system(dir);
      assert.equal(await stop(sys), 1);
      assert.match(text(), /doesn't answer as that Pebble worker.*Nothing was stopped/);
      assert.ok(alive(worker.pid));
      assert.ok(readRunState(sys.env), "the record is kept for a real check later");
      await server.close();
    }
  } finally {
    worker.kill("SIGKILL");
    await exited(worker);
    cleanup();
  }
});

test("a process that isn't pebble-worker is refused even if /health matches", async () => {
  const { dir, cleanup } = tempDataDir();
  const other = dummy(dir, "some-other-app");
  const server = await serve({
    healthBody: health({ instanceId: INSTANCE, workerVersion: VERSION }),
  });
  try {
    record(dir, {
      pid: other.pid,
      port: server.port,
      launcherPid: await deadPid(),
      webPid: await deadPid(),
    });
    const { sys } = system(dir);
    assert.equal(await stop(sys), 1);
    assert.ok(alive(other.pid));
  } finally {
    other.kill("SIGKILL");
    await exited(other);
    await server.close();
    cleanup();
  }
});

test("the matching worker is stopped politely and its record removed", async () => {
  const { dir, cleanup } = tempDataDir();
  const worker = dummy(dir, "pebble-worker-fake");
  const server = await serve({
    healthBody: health({ instanceId: INSTANCE, workerVersion: VERSION }),
  });
  try {
    record(dir, {
      pid: worker.pid,
      port: server.port,
      launcherPid: await deadPid(),
      webPid: await deadPid(),
    });
    const { sys, text } = system(dir);
    assert.equal(await stop(sys), 0);
    await exited(worker);
    assert.equal(worker.signalCode, "SIGTERM");
    assert.match(text(), /Pebble stopped\./);
    assert.equal(readRunState(sys.env), null);
  } finally {
    await server.close();
    cleanup();
  }
});

test("a worker that ignores the stop request is reported, never force-killed", async () => {
  const { dir, cleanup } = tempDataDir();
  const worker = dummy(dir, "pebble-worker-fake", { ignoreTerm: true });
  const server = await serve({
    healthBody: health({ instanceId: INSTANCE, workerVersion: VERSION }),
  });
  try {
    await new Promise((r) => setTimeout(r, 200)); // let it install its SIGTERM handler
    record(dir, {
      pid: worker.pid,
      port: server.port,
      launcherPid: await deadPid(),
      webPid: await deadPid(),
    });
    const { sys, text } = system(dir);
    assert.equal(await stop(sys, { timeoutMs: 300 }), 1);
    assert.match(text(), /didn't stop within 0 seconds and was left running/);
    assert.ok(alive(worker.pid));
  } finally {
    worker.kill("SIGKILL");
    await exited(worker);
    await server.close();
    cleanup();
  }
});
