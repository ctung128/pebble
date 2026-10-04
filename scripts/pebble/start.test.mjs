import assert from "node:assert/strict";
import { test } from "node:test";
import { VITE_BIN, WORKER_BIN } from "./paths.mjs";
import { readRunState } from "./runstate.mjs";
import { start } from "./start.mjs";
import { INSTANCE, fakeChild, fakeSystem, health, tempDataDir, workerReport } from "./testkit.mjs";

function launchable(dir, options = {}) {
  const fake = fakeSystem({ dataDir: dir, ...options });
  const spawned = [];
  let stopHandler = null;
  fake.sys.spawn = (command, args, opts) => {
    const child = fakeChild(4000 + spawned.length);
    spawned.push({ command, args, opts, child });
    return child;
  };
  fake.sys.onSignals = (handler) => {
    stopHandler = handler;
  };
  return { ...fake, spawned, stop: () => stopHandler?.() };
}

test("incomplete setup names the next command and starts nothing", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const report = () => workerReport({ models: { ...workerReport().models, state: "missing" } });
    const fake = launchable(dir, { report });
    assert.equal(await start(fake.sys), 1);
    assert.match(
      fake.text(),
      /Pebble isn't set up yet: speech models not downloaded.*npm run pebble:setup/,
    );
    assert.equal(fake.spawned.length, 0);
    assert.equal(readRunState(fake.sys.env), null);
  } finally {
    cleanup();
  }
});

test("a running compatible worker is reported, never duplicated", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = launchable(dir, { workerPort: { state: "pebble", health: health() } });
    assert.equal(await start(fake.sys), 0);
    assert.match(fake.text(), /Pebble is already running \(worker on port 8790\)/);
    assert.equal(fake.spawned.length, 0);
  } finally {
    cleanup();
  }
});

test("an incompatible worker, another program or a busy app port stops the start", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    for (const [options, expected] of [
      [{ workerPort: { state: "pebble-incompatible" } }, /Stop it with npm run pebble:stop/],
      [{ workerPort: { state: "other" } }, /Pebble won't touch it.*PEBBLE_PORT=8791/],
      [{ webPort: { state: "other" } }, /Port 5175 is used by another program/],
      [{ webPort: { state: "pebble" } }, /already being served on port 5175/],
    ]) {
      const fake = launchable(dir, options);
      assert.equal(await start(fake.sys), 1);
      assert.match(fake.text(), expected);
      assert.equal(fake.spawned.length, 0);
    }
  } finally {
    cleanup();
  }
});

test("an alternate port reaches both processes; the URL prints before models are ready", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = launchable(dir, { env: { PEBBLE_PORT: "8791" } });
    const probes = [];
    fake.sys.httpGet = async (port, path) => {
      probes.push(`${port}${path}`);
      if (path === "/health") {
        // Still checking the models: start must not wait for "ready".
        return { status: 200, body: JSON.stringify(health({ instanceId: INSTANCE })) };
      }
      return { status: 200, body: "<title>Pebble</title>" };
    };
    const running = start(fake.sys);
    while (!fake.text().includes("Press Ctrl+C")) await new Promise((r) => setTimeout(r, 5));

    const [worker, web] = fake.spawned;
    assert.equal(worker.command, WORKER_BIN);
    assert.deepEqual(worker.args, ["serve"]);
    assert.equal(worker.opts.env.PEBBLE_PORT, "8791");
    assert.equal(worker.opts.env.PEBBLE_PROVIDER, "funasr");
    assert.equal(worker.opts.env.PEBBLE_INSTANCE_ID, INSTANCE);
    assert.equal(web.command, VITE_BIN);
    assert.deepEqual(web.args, ["--port", "5175", "--strictPort"]);
    assert.equal(web.opts.env.VITE_PEBBLE_WORKER_URL, "http://127.0.0.1:8791");
    assert.equal(web.opts.env.VITE_PEBBLE_MODE, "local");
    assert.ok(probes.includes("8791/health"));

    const state = readRunState(fake.sys.env);
    assert.equal(state.instanceId, INSTANCE);
    assert.equal(state.worker.port, 8791);
    assert.match(fake.text(), /Pebble is starting: open http:\/\/localhost:5175/);
    assert.match(fake.text(), /The app will confirm when local speech models are ready\./);

    fake.stop(); // Ctrl+C
    assert.equal(await running, 0);
    assert.deepEqual(worker.child.kills, ["SIGTERM"]);
    assert.deepEqual(web.child.kills, ["SIGTERM"]);
    assert.equal(readRunState(fake.sys.env), null);
    assert.match(fake.text(), /Pebble stopped\./);
  } finally {
    cleanup();
  }
});

test("a worker that never answers is stopped again and reported", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = launchable(dir);
    assert.equal(await start(fake.sys, { readyTimeoutMs: 30 }), 1);
    assert.match(fake.text(), /Pebble couldn't start\. The details are in/);
    assert.ok(fake.spawned.every(({ child }) => child.kills.includes("SIGTERM")));
    assert.equal(readRunState(fake.sys.env), null);
  } finally {
    cleanup();
  }
});

test("a health answer from another run doesn't count as ready", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = launchable(dir);
    fake.sys.httpGet = async (port, path) =>
      path === "/health"
        ? { status: 200, body: JSON.stringify(health({ instanceId: "f".repeat(32) })) }
        : { status: 200, body: "<title>Pebble</title>" };
    assert.equal(await start(fake.sys, { readyTimeoutMs: 30 }), 1);
  } finally {
    cleanup();
  }
});

test("an invalid PEBBLE_PORT is refused before anything starts", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = launchable(dir, { env: { PEBBLE_PORT: "5175" } });
    assert.equal(await start(fake.sys), 1);
    assert.match(fake.text(), /PEBBLE_PORT must be a number/);
    assert.equal(fake.spawned.length, 0);
  } finally {
    cleanup();
  }
});

test("Ctrl+C while waiting for startup stops what was started", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = launchable(dir);
    const running = start(fake.sys, { readyTimeoutMs: 10_000 }); // never becomes ready
    while (fake.spawned.length < 2) await new Promise((r) => setTimeout(r, 5));
    fake.stop();
    assert.equal(await running, 0);
    assert.ok(fake.spawned.every(({ child }) => child.kills.includes("SIGTERM")));
    assert.equal(readRunState(fake.sys.env), null);
    assert.match(fake.text(), /Pebble stopped\./);
  } finally {
    cleanup();
  }
});
