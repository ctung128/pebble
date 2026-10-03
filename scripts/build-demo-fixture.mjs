#!/usr/bin/env node
/**
 * Builds the DEVELOPMENT PLACEHOLDER demo fixture: renders each script line with macOS
 * text-to-speech, trims edge silence, joins the lines with fixed gaps, and writes
 * audio.m4a plus a transcript.json whose timings are exact by construction.
 *
 * The output is synthetic speech and must be replaced with authorized audio before any
 * public deployment (see fixtures/demo/PROVENANCE.md). To replace it, skip this script:
 * drop in the real audio, write transcript.json by hand (or from the local worker later),
 * update durationMs in manifest.json, and run `npm test` to validate the fixture.
 *
 * Requires macOS `say` and `ffmpeg` on PATH. Usage: node scripts/build-demo-fixture.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EPISODE_ID = "demo-001";
const DEMO_DIR = fileURLToPath(new URL("../fixtures/demo/", import.meta.url));
const EPISODE_DIR = join(DEMO_DIR, EPISODE_ID);

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

function renderLine(workDir, i, { speaker, text }) {
  const aiff = join(workDir, `${i}.aiff`);
  const raw = join(workDir, `${i}.raw`);
  run("say", ["-v", VOICES[speaker], "-r", SPEECH_RATE, "-o", aiff, text]);
  run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    aiff,
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
  if (process.platform !== "darwin") throw new Error("This script uses macOS `say`.");
  const lines = readScript();
  const workDir = mkdtempSync(join(tmpdir(), "pebble-fixture-"));

  try {
    const parts = [silence(LEAD_IN_MS)];
    const segments = [];
    let cursor = samplesFor(LEAD_IN_MS);

    lines.forEach((line, i) => {
      const pcm = renderLine(workDir, i, line);
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
      "64k",
      "-movflags",
      "+faststart",
      "-map_metadata",
      "-1",
      "-metadata",
      "title=Pebble development placeholder (synthetic TTS)",
      "-metadata",
      "comment=Not for public distribution. See fixtures/demo/PROVENANCE.md.",
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
        notes:
          "Authored script text, not ASR output. Timings measured from per-line macOS TTS renders (development placeholder audio).",
      },
    };
    writeFileSync(join(EPISODE_DIR, "transcript.json"), `${JSON.stringify(transcript, null, 2)}\n`);

    const manifestPath = join(DEMO_DIR, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entry = manifest.episodes.find((e) => e.id === EPISODE_ID);
    if (!entry) throw new Error(`manifest.json has no episode "${EPISODE_ID}"`);
    entry.durationMs = durationMs;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(
      `Wrote ${EPISODE_ID}: ${segments.length} segments, ${(durationMs / 1000).toFixed(1)}s`,
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
