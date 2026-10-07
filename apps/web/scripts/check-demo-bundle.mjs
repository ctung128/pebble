// Fails the demo build if any local-mode code reached it: the public demo must contain no
// worker URL, upload UI, upload request code, local speech-recognition (FunASR) copy or model
// identifiers, or local translation copy, routes, consent/settings UI or provider name (one
// schema identifier excepted; see demoBundleGuard.mjs). Skipped for local-mode builds.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findDemoBundleLeaks } from "./demoBundleGuard.mjs";

if (process.env.VITE_PEBBLE_MODE === "local") process.exit(0);

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(js|html|css)$/.test(name)) files.push(path);
  }
})(dist);

const leaks = findDemoBundleLeaks(
  files.map((file) => ({ name: file, text: readFileSync(file, "utf8") })),
);

if (leaks.length > 0) {
  console.error("Demo build contains local-mode code:\n  " + leaks.join("\n  "));
  process.exit(1);
}
console.log(`Demo bundle check: ${files.length} files, no local-mode code.`);
