#!/usr/bin/env node
/**
 * Builds the bundled Huiwen Mincho subset (apps/web/src/assets/fonts/huiwen-mincho-subset.woff2)
 * so the display font shows on devices that don't have it installed. The full font is ~24 MB;
 * the subset keeps only Latin, common punctuation and the Chinese characters the app's display
 * text can use: CJK characters in the web app's source and the demo episodes' Chinese titles.
 *
 * Rerun it when display text gains new Chinese characters (e.g. a new demo episode title).
 * Characters outside the subset fall back to the next --font-display family (Songti SC…).
 *
 * Requires `uv` (fonttools runs in a throwaway environment; nothing is installed globally).
 * Usage: node scripts/build-display-font.mjs [path/to/汇文明朝体.otf]
 *        (default: ~/Library/Fonts/汇文明朝体.otf)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE = process.argv[2] ?? join(homedir(), "Library/Fonts/汇文明朝体.otf");
const OUTPUT = join(ROOT, "apps/web/src/assets/fonts/huiwen-mincho-subset.woff2");
const FONTTOOLS = ["fonttools==4.60.1", "brotli==1.1.0"];

// Basic Latin, Latin-1, general punctuation (dashes, curly quotes, ellipsis), ×.
const UNICODES = "U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030-203A,U+00D7";
// CJK symbols and punctuation, unified ideographs, full-width forms.
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/gu;

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function collectChinese() {
  const chars = new Set();
  for (const file of sourceFiles(join(ROOT, "apps/web/src"))) {
    for (const ch of readFileSync(file, "utf8").match(CJK) ?? []) chars.add(ch);
  }
  const manifest = JSON.parse(readFileSync(join(ROOT, "fixtures/demo/manifest.json"), "utf8"));
  for (const episode of manifest.episodes) {
    for (const ch of (episode.titleZh ?? "").match(CJK) ?? []) chars.add(ch);
  }
  return [...chars].sort().join("");
}

function main() {
  const text = collectChinese();
  const work = mkdtempSync(join(tmpdir(), "pebble-font-"));
  try {
    const textFile = join(work, "chars.txt");
    writeFileSync(textFile, text);
    execFileSync(
      "uv",
      [
        "run",
        "--no-project",
        ...FONTTOOLS.flatMap((dep) => ["--with", dep]),
        "pyftsubset",
        SOURCE,
        `--unicodes=${UNICODES}`,
        `--text-file=${textFile}`,
        "--flavor=woff2",
        "--layout-features=kern,liga,palt,vert,vrt2",
        "--no-hinting",
        "--desubroutinize",
        "--name-IDs=*",
        `--output-file=${OUTPUT}`,
      ],
      {
        stdio: ["ignore", "inherit", "inherit"],
        // The repository's uv cache, as for the worker.
        env: {
          ...process.env,
          UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? join(homedir(), ".pebble/uv-cache"),
        },
      },
    );
  } catch (error) {
    if (error.code === "ENOENT") throw new Error('"uv" was not found on PATH.', { cause: error });
    throw error;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const kb = (statSync(OUTPUT).size / 1024).toFixed(1);
  console.log(`Wrote ${OUTPUT} (${kb} KB, ${[...text].length} Chinese characters + Latin)`);
}

try {
  main();
} catch (error) {
  console.error(`build-display-font: ${error.message}`);
  process.exit(1);
}
