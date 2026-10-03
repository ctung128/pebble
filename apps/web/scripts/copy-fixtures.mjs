// Copies fixtures/demo into public/demo so Vite serves and bundles it as static files.
// The copy is gitignored; fixtures/demo is the single source of truth.
import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../../fixtures/demo/", import.meta.url));
const target = fileURLToPath(new URL("../public/demo/", import.meta.url));

rmSync(target, { recursive: true, force: true });
cpSync(source, target, {
  recursive: true,
  // Only ship what the app reads; scripts and provenance notes stay in the repo.
  filter: (path) => !/\.(txt|md)$/.test(path),
});
console.log("Copied fixtures/demo → apps/web/public/demo");
