import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKER_BIN } from "./paths.mjs";
import { setup } from "./setup.mjs";
import { fakeSystem, tempDataDir, workerReport } from "./testkit.mjs";

const missingModels = () =>
  workerReport({
    models: { ...workerReport().models, state: "missing", present: 0, presentBytes: 0 },
  });

/** A fake where `uv sync` creates the environment and `models pull` downloads the models. */
function scenario(dir, options = {}) {
  let pulled = options.modelsPresent ?? false;
  const report = (verify) => {
    if (!pulled) return missingModels();
    const models = { ...workerReport().models };
    if (verify) Object.assign(models, { state: "verified", verified: true });
    return workerReport({ models });
  };
  return fakeSystem({
    dataDir: dir,
    report,
    onRun: (command, args, state) => {
      if (command === "npm" && args[0] === "ci") state.webPackages = true;
      if (command === "uv" && args[0] === "sync") state.environment = true;
      if (command === "uv" && args[0] === "python")
        return { code: options.python ? 0 : 1, stdout: "" };
      if (command === WORKER_BIN && args[0] === "models") pulled = true;
      return null;
    },
    ...options,
  });
}

const installs = (calls) =>
  calls.filter(
    ({ command, args }) =>
      (command === "npm" && args[0] === "ci") ||
      (command === "uv" && args[0] === "sync") ||
      (command === WORKER_BIN && args[0] === "models"),
  );

test("missing system tools are never installed; setup shows the commands and stops", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = scenario(dir, { tools: { uv: false, ffmpeg: false, ffprobe: true } });
    assert.equal(await setup(fake.sys), 1);
    assert.match(fake.text(), /Pebble can't install these for you/);
    assert.match(fake.text(), /brew install uv/);
    assert.match(fake.text(), /brew install ffmpeg/);
    assert.match(fake.text(), /Nothing was changed\./);
    assert.deepEqual(installs(fake.calls), []);
    assert.deepEqual(fake.prompts, []);
  } finally {
    cleanup();
  }
});

test("declining the first change says nothing was changed", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = scenario(dir, { webPackages: false, environment: false, answers: [false] });
    assert.equal(await setup(fake.sys), 1);
    assert.equal(fake.prompts.length, 1);
    assert.match(fake.prompts[0], /node_modules folder inside this Pebble folder/);
    assert.match(fake.text(), /Nothing was changed\./);
    assert.deepEqual(installs(fake.calls), []);
  } finally {
    cleanup();
  }
});

test("declining after an approved step says no further changes were made", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = scenario(dir, { environment: false, python: true, answers: [true, false] });
    assert.equal(await setup(fake.sys), 1);
    assert.match(fake.prompts[0], /services\/worker\/\.venv inside this Pebble folder/);
    assert.match(fake.prompts[0], /Nothing is installed system-wide/);
    assert.doesNotMatch(fake.prompts[0], /download Python/); // a Python 3.12 was found
    assert.match(fake.prompts[1], /download its speech models once: about 1\.3 GB/);
    assert.match(fake.text(), /No further changes were made\. You can resume setup later/);
    assert.doesNotMatch(fake.text(), /Nothing was changed/);
    assert.deepEqual(
      installs(fake.calls).map((c) => c.args[0]),
      ["sync"],
    );
  } finally {
    cleanup();
  }
});

test("the environment prompt discloses a Python download when one is needed", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = scenario(dir, { environment: false, python: false, answers: [false] });
    await setup(fake.sys);
    assert.match(fake.prompts[0], /uv will also download Python 3\.12 into .*uv-python/);
    const quiet = scenario(dir, { environment: false, python: true, answers: [false] });
    await setup(quiet.sys);
    assert.doesNotMatch(quiet.prompts[0], /download Python/);
  } finally {
    cleanup();
  }
});

test("the model download asks first and states size, location, privacy and resume", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = scenario(dir, { answers: [true] });
    assert.equal(await setup(fake.sys), 0);
    const [prompt] = fake.prompts;
    assert.match(prompt, /about 1\.3 GB/);
    assert.match(prompt, /saved to ~\/\.pebble-test\/models/);
    assert.match(prompt, /once/);
    assert.match(prompt, /No audio ever leaves it/);
    assert.match(prompt, /Ctrl\+C/);
    assert.match(prompt, /downloads any unfinished model again/);
    const pull = fake.calls.find((c) => c.command === WORKER_BIN && c.args[0] === "models");
    assert.deepEqual(pull.args, ["models", "pull"]);
    const verify = fake.calls.filter(
      (c) => c.command === WORKER_BIN && c.args.includes("--verify"),
    );
    assert.ok(verify.length >= 1, "setup ends with a full checksum check");
    assert.match(fake.text(), /Setup complete/);
  } finally {
    cleanup();
  }
});

test("declining the model download leaves the models alone", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = scenario(dir, { answers: [false] });
    assert.equal(await setup(fake.sys), 1);
    assert.deepEqual(installs(fake.calls), []);
    assert.match(fake.text(), /Nothing was changed\./);
  } finally {
    cleanup();
  }
});

test("without a terminal, setup changes nothing and asks to be run interactively", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = scenario(dir, { isTTY: false, environment: false });
    assert.equal(await setup(fake.sys), 1);
    assert.deepEqual(fake.prompts, []);
    assert.deepEqual(installs(fake.calls), []);
    assert.match(fake.text(), /run it in a terminal window/);
  } finally {
    cleanup();
  }
});

test("not enough disk space stops before asking", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = scenario(dir, { free: 0.5e9, answers: [true] });
    assert.equal(await setup(fake.sys), 1);
    assert.deepEqual(fake.prompts, []);
    assert.match(fake.text(), /needs about 1\.8 GB of free disk space/);
  } finally {
    cleanup();
  }
});

test("checksum failures offer a re-download, asking first", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    let repaired = false;
    const report = (verify) => {
      const models = { ...workerReport().models };
      if (verify)
        Object.assign(
          models,
          repaired ? { state: "verified", verified: true } : { state: "failed", verified: false },
        );
      return workerReport({ models });
    };
    const fake = fakeSystem({
      dataDir: dir,
      report,
      answers: [true],
      onRun: (command, args) => {
        if (command === WORKER_BIN && args[0] === "models") repaired = true;
        return null;
      },
    });
    assert.equal(await setup(fake.sys), 0);
    assert.match(fake.prompts[0], /don't match their checksums/);
    assert.match(fake.text(), /Setup complete/);
  } finally {
    cleanup();
  }
});
