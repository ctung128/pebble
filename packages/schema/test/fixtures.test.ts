import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseDemoTranslations,
  parseIllustrativeUncertainty,
  parseManifest,
  parseTranscript,
} from "../src/index.ts";

/** Validates the demo fixtures that the web app ships, so a replaced fixture can't drift. */
const demoDir = new URL("../../../fixtures/demo/", import.meta.url);
const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));

const manifest = parseManifest(readJson(new URL("manifest.json", demoDir)));

describe("fixtures/demo", () => {
  it("has a valid manifest", () => {
    expect(manifest.ok ? [] : manifest.issues).toEqual([]);
  });

  const episodes = manifest.ok ? manifest.data.episodes : [];

  it.each(episodes.map((e) => [e.id, e] as const))(
    "%s has audio and a matching transcript",
    (_, episode) => {
      expect(existsSync(new URL(episode.audio.src, demoDir))).toBe(true);

      const transcript = parseTranscript(readJson(new URL(episode.transcript.src, demoDir)));
      expect(transcript.ok ? [] : transcript.issues).toEqual([]);
      if (!transcript.ok) return;

      expect(transcript.data.episodeId).toBe(episode.id);
      expect(transcript.data.durationMs).toBe(episode.durationMs);
      expect(transcript.data.segments.length).toBeGreaterThan(0);
      // Demo transcripts are authored text: they must never carry confidence values.
      expect(transcript.data.segments.every((s) => s.confidence === null)).toBe(true);

      const segmentIds = new Set(transcript.data.segments.map((s) => s.id));

      if (episode.demo?.translations) {
        const translations = parseDemoTranslations(
          readJson(new URL(episode.demo.translations, demoDir)),
        );
        expect(translations.ok ? [] : translations.issues).toEqual([]);
        if (translations.ok) {
          expect(translations.data.episodeId).toBe(episode.id);
          for (const id of Object.keys(translations.data.translations)) {
            expect(segmentIds).toContain(id);
          }
        }
      }

      if (episode.demo?.illustrativeUncertainty) {
        const flags = parseIllustrativeUncertainty(
          readJson(new URL(episode.demo.illustrativeUncertainty, demoDir)),
        );
        expect(flags.ok ? [] : flags.issues).toEqual([]);
        if (flags.ok) {
          expect(flags.data.episodeId).toBe(episode.id);
          for (const { segmentId } of flags.data.segments) expect(segmentIds).toContain(segmentId);
        }
      }
    },
  );
});
