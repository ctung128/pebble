// Fails the demo build if any local-mode code reached it: the public demo must contain no
// worker URL, upload UI, upload request code, or local speech-recognition (FunASR) copy or
// model identifiers. Skipped for local-mode builds.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.VITE_PEBBLE_MODE === "local") process.exit(0);

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const FORBIDDEN = [
  "127.0.0.1:8790", // worker URL
  "Process audio locally", // upload page
  "Run processing preview",
  "ownershipConfirmed", // upload request field
  "pebble-worker",
  "FunASR", // local transcript notice and provider names
  "Paraformer",
  "iic/speech_", // model identifiers
  "iic/punc_",
  "Create a transcript locally", // provider-aware local copy
  "Checking local speech models",
  "Local transcription is ready",
  "local transcription needs setup",
];

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(js|html|css)$/.test(name)) files.push(path);
  }
})(dist);

const leaks = files.flatMap((file) => {
  const text = readFileSync(file, "utf8");
  return FORBIDDEN.filter((marker) => text.includes(marker)).map((m) => `${file}: "${m}"`);
});

if (leaks.length > 0) {
  console.error("Demo build contains local-mode code:\n  " + leaks.join("\n  "));
  process.exit(1);
}
console.log(`Demo bundle check: ${files.length} files, no local-mode code.`);
