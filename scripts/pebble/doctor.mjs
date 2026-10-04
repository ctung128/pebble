// `npm run pebble:doctor [-- --verify]`: read-only. Creates, installs, downloads and starts
// nothing; `--verify` additionally hashes every speech model file.
import { collectChecks } from "./checks.mjs";
import { DOCTOR } from "./copy.mjs";

export function printChecks(sys, checks) {
  const width = Math.max(...checks.map((check) => check.label.length));
  for (const check of checks) {
    const status = check.ok ? "ready          " : "needs attention";
    sys.print(`  ${status}  ${check.label.padEnd(width)}  ${check.detail}`);
    if (check.next) sys.print(`  ${" ".repeat(15)}  → ${check.next}`);
  }
}

export async function doctor(sys, { verify = false } = {}) {
  sys.print(DOCTOR.title(verify));
  if (verify) sys.print(DOCTOR.verifying);
  const { checks, info } = await collectChecks(sys, { verify });
  printChecks(sys, checks);
  sys.print();
  if (!verify && info.models?.state === "present") sys.print(DOCTOR.integrityNotRun);
  const problems = checks.filter((check) => !check.ok).length;
  sys.print(problems ? DOCTOR.problems(problems) : DOCTOR.allReady);
  return problems ? 1 : 0;
}
