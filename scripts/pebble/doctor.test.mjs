import assert from "node:assert/strict";
import { test } from "node:test";
import { collectChecks } from "./checks.mjs";
import { doctor } from "./doctor.mjs";
import { WORKER_BIN } from "./paths.mjs";
import { fakeSystem, tempDataDir, workerReport } from "./testkit.mjs";

/** Only version commands and the read-only worker check may run. */
function assertReadOnly(calls) {
  for (const { command, args } of calls) {
    const allowed =
      (["uv", "ffmpeg", "ffprobe"].includes(command) && /version/.test(args[0])) ||
      (command === WORKER_BIN && args[0] === "check");
    assert.ok(allowed, `doctor ran ${command} ${args.join(" ")}`);
  }
}

test("a ready system passes and says full verification hasn't run", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = fakeSystem({ dataDir: dir });
    assert.equal(await doctor(fake.sys), 0);
    assert.match(fake.text(), /read-only: nothing is changed/);
    assert.match(fake.text(), /full checksum check hasn't run/);
    assert.match(fake.text(), /Everything is ready/);
    assertReadOnly(fake.calls);
    const check = fake.calls.find((c) => c.command === WORKER_BIN);
    assert.deepEqual(check.args, ["check", "--json"]);
    assert.equal(check.options.env.PYTHONDONTWRITEBYTECODE, "1");
  } finally {
    cleanup();
  }
});

test("--verify asks the worker for the full checksum check", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const report = (verify) =>
      workerReport({
        models: {
          ...workerReport().models,
          state: verify ? "verified" : "present",
          verified: verify,
        },
      });
    const fake = fakeSystem({ dataDir: dir, report });
    assert.equal(await doctor(fake.sys, { verify: true }), 0);
    assert.deepEqual(fake.calls.find((c) => c.command === WORKER_BIN).args, [
      "check",
      "--json",
      "--verify",
    ]);
    assert.match(fake.text(), /all 14 files verified/);
    assert.doesNotMatch(fake.text(), /hasn't run/);
  } finally {
    cleanup();
  }
});

test("every problem gets exactly one next step, and nothing is changed", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = fakeSystem({
      dataDir: dir,
      tools: { uv: false, ffmpeg: false, ffprobe: false },
      webPackages: false,
      environment: false,
      free: 1e9,
      workerPort: { state: "other" },
      webPort: { state: "other" },
    });
    assert.equal(await doctor(fake.sys), 1);
    const { checks } = await collectChecks(fake.sys);
    for (const check of checks) {
      if (check.ok) assert.equal(check.next, null, check.id);
      else {
        assert.equal(typeof check.next, "string", check.id);
        assert.ok((check.next.match(/npm run|brew install/g) ?? []).length <= 1);
      }
    }
    const failing = checks.filter((c) => !c.ok).map((c) => c.id);
    for (const id of ["uv", "ffmpeg", "ffprobe", "webPackages", "environment", "models", "disk"]) {
      assert.ok(failing.includes(id), id);
    }
    assert.match(fake.text(), /Install FFmpeg yourself/);
    assert.match(fake.text(), /PEBBLE_PORT=8791 npm run pebble:start/);
    assertReadOnly(fake.calls);
  } finally {
    cleanup();
  }
});

test("a data folder others can read gets the chmod step", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const report = () =>
      workerReport({ dataDir: { path: "~/x", exists: true, private: false, writable: true } });
    const { checks } = await collectChecks(fakeSystem({ dataDir: dir, report }).sys);
    const data = checks.find((c) => c.id === "dataDir");
    assert.equal(data.ok, false);
    assert.match(data.next, /^Make it private to you: chmod 700 /);
  } finally {
    cleanup();
  }
});

test("model states map to plain descriptions", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    for (const [state, expected, ok] of [
      ["missing", /not downloaded \(about 1\.3 GB\)/, false],
      ["incomplete", /incomplete/, false],
      ["wrong_size", /wrong size/, false],
      ["failed", /don't match their checksums/, false],
    ]) {
      const report = () =>
        workerReport({ models: { ...workerReport().models, state, presentBytes: 0 } });
      const { checks } = await collectChecks(fakeSystem({ dataDir: dir, report }).sys);
      const models = checks.find((c) => c.id === "models");
      assert.equal(models.ok, ok);
      assert.match(models.detail, expected);
      assert.equal(models.next, "Run npm run pebble:setup.");
    }
  } finally {
    cleanup();
  }
});
