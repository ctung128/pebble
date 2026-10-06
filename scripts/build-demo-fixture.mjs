#!/usr/bin/env node
/**
 * Builds a demo fixture from its script: gets audio for each script line, trims edge
 * silence, joins the lines with fixed gaps, and writes audio.m4a plus a transcript.json whose
 * timings are exact by construction.
 *
 * Line audio comes from one of two sources:
 * - default: macOS `say` (DEVELOPMENT PLACEHOLDER, not publishable; see PROVENANCE.md)
 * - `--lines`: one prepared file per script line in `<episode>/lines/`, named by line
 *   number (`01.mp3`, `02.mp3`, …; mp3, wav, m4a or aiff). Used for the LuvVoice neural TTS
 *   renders. This marks the episode's audio as licensed and publishable in manifest.json.
 *
 * Requires `ffmpeg` on PATH (and macOS `say` without `--lines`).
 * Usage: node scripts/build-demo-fixture.mjs [episode-id] [--lines]   (default demo-001)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const FROM_LINES = args.includes("--lines");
const EPISODE_ID = args.find((arg) => !arg.startsWith("--")) ?? "demo-001";
if (!/^demo-\d{3}$/.test(EPISODE_ID)) {
  console.error(`build-demo-fixture: bad episode id "${EPISODE_ID}"`);
  process.exit(1);
}
const DEMO_DIR = fileURLToPath(new URL("../fixtures/demo/", import.meta.url));
const EPISODE_DIR = join(DEMO_DIR, EPISODE_ID);
const LINES_DIR = join(EPISODE_DIR, "lines");
const LINE_FILE = /^(\d+)\.(mp3|wav|m4a|aiff)$/;

const SOURCES = {
  say: {
    title: "Pebble development placeholder (synthetic TTS)",
    comment: "Not for public distribution. See fixtures/demo/PROVENANCE.md.",
    transcriptNotes:
      "Authored script text, not ASR output. Timings measured from per-line macOS TTS renders (development placeholder audio).",
    audioProvenance: null, // left as is in manifest.json
  },
  lines: {
    title: "Pebble demo (synthetic neural TTS)",
    comment: "AI-generated voices (LuvVoice). See fixtures/demo/PROVENANCE.md.",
    transcriptNotes:
      "Authored script text, not ASR output. Timings measured from per-line neural TTS renders (LuvVoice).",
    audioProvenance: {
      kind: "licensed",
      publishable: true,
      notes:
        "AI-generated speech (LuvVoice neural text-to-speech, Microsoft Azure / Google Cloud voices) of an original script. LuvVoice Terms of Service (updated 2026-08-02, checked 2026-10-06) assign ownership of generated audio to the user; disclosed as synthetic.",
    },
  },
};
const SOURCE = SOURCES[FROM_LINES ? "lines" : "say"];

const VOICES = { A: "Tingting", B: "Eddy (Chinese (China mainland))" };
const SPEECH_RATE = "165"; // words per minute; a little slower than the default for learners
const SAMPLE_RATE = 24_000;
const LEAD_IN_MS = 300;
const GAP_MS = 450;
const TAIL_MS = 600;
const EDGE_PAD_MS = 40; // silence kept around each trimmed line
const SILENCE_THRESHOLD = 300; // |sample| below this (of 32767) counts as silence

const samplesFor = (ms) => Math.round((ms * SAMPLE_RATE) / 1000);
const msFor = (samples) => Math.round((samples * 1000) / SAMPLE_RATE);
const silence = (ms) => Buffer.alloc(samplesFor(ms) * 2);

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(`"${cmd}" was not found on PATH.`, { cause: error });
    throw new Error(`${cmd} failed: ${error.stderr?.toString().trim() || error.message}`, {
      cause: error,
    });
  }
}

function readScript() {
  return readFileSync(join(EPISODE_DIR, "script.zh.txt"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line, i) => {
      const match = /^([A-Z]):\s*(.+)$/.exec(line);
      if (!match || !VOICES[match[1]]) throw new Error(`Bad script line ${i + 1}: ${line}`);
      return { speaker: match[1], text: match[2] };
    });
}

/** Trims leading/trailing near-silence from 16-bit mono PCM, keeping a small pad. */
function trimSilence(pcm) {
  const count = pcm.length / 2;
  let first = 0;
  let last = count - 1;
  while (first < count && Math.abs(pcm.readInt16LE(first * 2)) < SILENCE_THRESHOLD) first++;
  while (last > first && Math.abs(pcm.readInt16LE(last * 2)) < SILENCE_THRESHOLD) last--;
  const pad = samplesFor(EDGE_PAD_MS);
  const start = Math.max(0, first - pad);
  const end = Math.min(count, last + 1 + pad);
  return pcm.subarray(start * 2, end * 2);
}

/** Maps line number (1-based) to its prepared file, checking it matches the script. */
function findLineFiles(lineCount) {
  if (!existsSync(LINES_DIR)) throw new Error(`No line audio folder at ${LINES_DIR}`);
  const files = new Map();
  for (const name of readdirSync(LINES_DIR)) {
    const match = LINE_FILE.exec(name);
    if (!match) continue;
    const number = Number(match[1]);
    if (files.has(number)) throw new Error(`Two files for line ${number} in ${LINES_DIR}`);
    files.set(number, join(LINES_DIR, name));
  }
  const missing = [];
  for (let n = 1; n <= lineCount; n++) if (!files.has(n)) missing.push(n);
  const extra = [...files.keys()].filter((n) => n < 1 || n > lineCount);
  if (missing.length) throw new Error(`Missing line audio for line(s) ${missing.join(", ")}`);
  if (extra.length)
    throw new Error(`Line audio for line(s) ${extra.join(", ")}, but the script has ${lineCount}`);
  return files;
}

function renderLine(workDir, i, { speaker, text }, lineFiles) {
  let input = lineFiles?.get(i + 1);
  if (!input) {
    input = join(workDir, `${i}.aiff`);
    run("say", ["-v", VOICES[speaker], "-r", SPEECH_RATE, "-o", input, text]);
  }
  const raw = join(workDir, `${i}.raw`);
  run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    input,
    "-ac",
    "1",
    "-ar",
    String(SAMPLE_RATE),
    "-f",
    "s16le",
    raw,
  ]);
  return trimSilence(readFileSync(raw));
}

function main() {
  if (!FROM_LINES && process.platform !== "darwin")
    throw new Error("This script uses macOS `say` (or pass --lines).");
  const lines = readScript();
  const lineFiles = FROM_LINES ? findLineFiles(lines.length) : null;
  const workDir = mkdtempSync(join(tmpdir(), "pebble-fixture-"));

  try {
    const parts = [silence(LEAD_IN_MS)];
    const segments = [];
    let cursor = samplesFor(LEAD_IN_MS);

    lines.forEach((line, i) => {
      const pcm = renderLine(workDir, i, line, lineFiles);
      const samples = pcm.length / 2;
      segments.push({
        id: `seg-${String(i + 1).padStart(4, "0")}`,
        index: i,
        startMs: msFor(cursor),
        endMs: msFor(cursor + samples),
        text: line.text,
        speaker: line.speaker,
        confidence: null,
        tokens: null,
      });
      parts.push(pcm);
      cursor += samples;
      if (i < lines.length - 1) {
        parts.push(silence(GAP_MS));
        cursor += samplesFor(GAP_MS);
      }
    });
    parts.push(silence(TAIL_MS));
    cursor += samplesFor(TAIL_MS);
    const durationMs = msFor(cursor);

    const combined = join(workDir, "combined.raw");
    writeFileSync(combined, Buffer.concat(parts));
    run("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "s16le",
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      "1",
      "-i",
      combined,
      "-c:a",
      "aac",
      "-b:a",
      FROM_LINES ? "96k" : "64k",
      "-movflags",
      "+faststart",
      "-map_metadata",
      "-1",
      "-metadata",
      `title=${SOURCE.title}`,
      "-metadata",
      `comment=${SOURCE.comment}`,
      join(EPISODE_DIR, "audio.m4a"),
    ]);

    const transcript = {
      schemaVersion: "1.0",
      episodeId: EPISODE_ID,
      language: "zh-CN",
      script: "simplified",
      durationMs,
      segments,
      provenance: {
        kind: "fixture",
        provider: "fixture",
        model: null,
        createdAt: new Date().toISOString(),
        notes: SOURCE.transcriptNotes,
      },
    };
    writeFileSync(join(EPISODE_DIR, "transcript.json"), `${JSON.stringify(transcript, null, 2)}\n`);

    const manifestPath = join(DEMO_DIR, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entry = manifest.episodes.find((e) => e.id === EPISODE_ID);
    if (!entry) throw new Error(`manifest.json has no episode "${EPISODE_ID}"`);
    entry.durationMs = durationMs;
    if (SOURCE.audioProvenance) entry.audioProvenance = SOURCE.audioProvenance;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(
      `Wrote ${EPISODE_ID} from ${FROM_LINES ? "lines/" : "macOS say"}: ${segments.length} segments, ${(durationMs / 1000).toFixed(1)}s`,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`build-demo-fixture: ${error.message}`);
  process.exit(1);
}
