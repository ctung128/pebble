import { z } from "zod";
import {
  DurationMsSchema,
  IdSchema,
  NonEmptyTextSchema,
  RelativePathSchema,
  SchemaVersionSchema,
} from "./common.ts";

export const AudioProvenanceSchema = z.object({
  /**
   * "tts-placeholder": synthetic speech for local development only.
   * The others are acceptable for public use once rights are documented.
   */
  kind: z.enum(["tts-placeholder", "self-recorded", "licensed", "permission-granted"]),
  /** False until the audio's rights are documented as allowing public distribution. */
  publishable: z.boolean(),
  notes: z.string(),
});

export const EpisodeSchema = z.object({
  id: IdSchema,
  title: NonEmptyTextSchema,
  titleZh: z.string().optional(),
  description: z.string(),
  language: z.string().min(2),
  durationMs: DurationMsSchema,
  audio: z.object({
    src: RelativePathSchema,
    mimeType: z.string().regex(/^audio\//, "expected an audio/* MIME type"),
  }),
  transcript: z.object({ src: RelativePathSchema }),
  audioProvenance: AudioProvenanceSchema,
});

export const ManifestSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    episodes: z.array(EpisodeSchema),
  })
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    manifest.episodes.forEach((episode, i) => {
      if (seen.has(episode.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["episodes", i, "id"],
          message: `duplicate episode id "${episode.id}"`,
        });
      }
      seen.add(episode.id);
    });
  });

export type AudioProvenance = z.infer<typeof AudioProvenanceSchema>;
export type Episode = z.infer<typeof EpisodeSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
