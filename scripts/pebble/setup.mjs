// `npm run pebble:setup`: guided. Runs the doctor checks, never installs Node, uv or FFmpeg,
// and asks before each change: app packages, the speech environment, the model download.
import path from "node:path";
import {
  ENVIRONMENT_BYTES,
  SYSTEM_CHECKS,
  WEB_PACKAGES_BYTES,
  byId,
  collectChecks,
} from "./checks.mjs";
import { SETUP, gb } from "./copy.mjs";
import { printChecks } from "./doctor.mjs";
import { REPO, WORKER_BIN, WORKER_DIR, dataDir, display } from "./paths.mjs";

const MARGIN_BYTES = 0.5e9;

export async function setup(sys) {
  sys.print(SETUP.title);
  sys.print();
  let changed = false;
  const stop = () => {
    sys.print(changed ? SETUP.noFurtherChanges : SETUP.nothingChanged);
    return 1;
  };
  const ask = async (question) => {
    sys.print();
    if (!sys.isTTY) {
      sys.print(SETUP.notInteractive);
      return false;
    }
    return sys.confirm(question);
  };
  const enoughSpace = (needed, free) => {
    if (free >= needed + MARGIN_BYTES) return true;
    sys.print(SETUP.diskShort(needed + MARGIN_BYTES, free));
    return false;
  };

  let { checks, info } = await collectChecks(sys);
  printChecks(sys, checks);
  sys.print();

  const system = checks.filter((c) => SYSTEM_CHECKS.includes(c.id) && !c.ok);
  if (system.length) {
    sys.print(SETUP.systemFirst);
    for (const check of system) sys.print(`  • ${check.label}: ${check.next}`);
    return stop();
  }

  const data = dataDir(sys.env);
  const uvEnv = {
    ...sys.env,
    UV_CACHE_DIR: path.join(data, "uv-cache"),
    UV_PYTHON_INSTALL_DIR: path.join(data, "uv-python"),
  };

  if (!byId(checks, "webPackages").ok) {
    if (!enoughSpace(WEB_PACKAGES_BYTES, info.free)) return stop();
    if (!(await ask(SETUP.confirmWebPackages(gb(WEB_PACKAGES_BYTES))))) return stop();
    changed = true;
    if (sys.run("npm", ["ci"], { cwd: REPO, inherit: true }).code !== 0) {
      sys.print(SETUP.stepFailed("Installing the app packages"));
      return 1;
    }
  }

  if (!byId(checks, "environment").ok) {
    if (!enoughSpace(ENVIRONMENT_BYTES, info.free)) return stop();
    const pythonDownload = sys.run("uv", ["python", "find", "3.12"], { env: uvEnv }).code !== 0;
    const question = SETUP.confirmEnvironment({
      size: "1 GB, plus about 1 GB of downloaded packages",
      pythonDownload,
      cacheDir: display(uvEnv.UV_CACHE_DIR),
      pythonDir: display(uvEnv.UV_PYTHON_INSTALL_DIR),
    });
    if (!(await ask(question))) return stop();
    changed = true;
    const args = ["sync", "--project", WORKER_DIR, "--frozen", "--extra", "funasr"];
    if (sys.run("uv", args, { env: uvEnv, cwd: REPO, inherit: true }).code !== 0) {
      sys.print(SETUP.stepFailed("Setting up the speech environment"));
      return 1;
    }
  }

  ({ info } = await collectChecks(sys));
  const models = info.models;
  if (!models || !sys.exists(WORKER_BIN)) {
    sys.print(SETUP.stepFailed("Setting up the speech environment"));
    return 1;
  }
  const pull = async (question) => {
    if (!enoughSpace(models.requiredBytes - models.presentBytes, info.free)) return false;
    if (!(await ask(question))) return false;
    changed = true;
    const result = sys.run(WORKER_BIN, ["models", "pull"], { env: sys.env, inherit: true });
    if (result.code !== 0) {
      sys.print(SETUP.stepFailed("The speech model download"));
      return null;
    }
    return true;
  };
  const location = models.location;
  if (models.state !== "present" && models.state !== "verified") {
    const pulled = await pull(SETUP.confirmModels({ size: gb(models.requiredBytes), location }));
    if (pulled === null) return 1;
    if (!pulled) return stop();
  }

  sys.print();
  sys.print(SETUP.verifying);
  ({ checks, info } = await collectChecks(sys, { verify: true }));
  if (info.models?.state === "failed") {
    const pulled = await pull(SETUP.confirmRedownload({ location }));
    if (pulled === null) return 1;
    if (!pulled) return stop();
    sys.print(SETUP.verifying);
    ({ checks, info } = await collectChecks(sys, { verify: true }));
  }
  const remaining = checks.filter((c) => !c.ok && c.id !== "workerPort" && c.id !== "webPort");
  if (remaining.length || info.models?.state !== "verified") {
    printChecks(sys, remaining);
    return stop();
  }
  sys.print(SETUP.complete);
  return 0;
}
