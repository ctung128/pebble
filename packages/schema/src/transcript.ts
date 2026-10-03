import { z } from "zod";
import {
  DurationMsSchema,
  IdSchema,
  IsoDateTimeSchema,
  NonEmptyTextSchema,
  SchemaVersionSchema,
  TimeMsSchema,
} from "./common.ts";

/** How far the last segment may run past `durationMs` (encoder padding, rounding). */
export const DURATION_TOLERANCE_MS = 500;

export const TokenSchema = z.object({
  text: z.string().min(1),
  startMs: TimeMsSchema,
  endMs: TimeMsSchema,
});

export const SegmentSchema = z.object({
  id: z.string().min(1),
  index: z.number().int().nonnegative(),
  startMs: TimeMsSchema,
  endMs: TimeMsSchema,
  text: NonEmptyTextSchema,
  /** Opaque speaker label; null when the source has no diarization. */
  speaker: z.string().min(1).nullable(),
  /**
   * Provider-reported confidence in [0, 1], or null when the provider does not supply one.
   * Never synthesized: null means "unknown", not "confident".
   */
  confidence: z.number().min(0).max(1).nullable(),
  /** Sub-segment timings (e.g. per character), when the provider supplies them. */
  tokens: z.array(TokenSchema).nullable(),
});

export const TranscriptProvenanceSchema = z.object({
  /**
   * "fixture": authored text with measured timings — not ASR output.
   * "asr": produced by a speech-recognition provider.
   * "mock": placeholder text from the mock provider (1.2) — never a transcription of the audio.
   */
  kind: z.enum(["fixture", "asr", "mock"]),
  provider: z.string().min(1),
  model: z.string().min(1).nullable(),
  createdAt: IsoDateTimeSchema,
  notes: z.string().optional(),
});

export const TranscriptSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    episodeId: IdSchema,
    language: z.string().min(2),
    script: z.enum(["simplified", "traditional", "unknown"]),
    durationMs: DurationMsSchema,
    segments: z.array(SegmentSchema),
    provenance: TranscriptProvenanceSchema,
  })
  .superRefine((transcript, ctx) => {
    const seen = new Set<string>();
    transcript.segments.forEach((segment, i) => {
      const at = (field: string) => ["segments", i, field];
      if (segment.index !== i) {
        ctx.addIssue({ code: "custom", path: at("index"), message: `expected index ${i}` });
      }
      if (seen.has(segment.id)) {
        ctx.addIssue({
          code: "custom",
          path: at("id"),
          message: `duplicate segment id "${segment.id}"`,
        });
      }
      seen.add(segment.id);
      if (segment.endMs <= segment.startMs) {
        ctx.addIssue({ code: "custom", path: at("endMs"), message: "endMs must be after startMs" });
      }
      const previous = transcript.segments[i - 1];
      if (previous && segment.startMs < previous.startMs) {
        ctx.addIssue({
          code: "custom",
          path: at("startMs"),
          message: "segments must be ordered by startMs",
        });
      }
      if (segment.endMs > transcript.durationMs + DURATION_TOLERANCE_MS) {
        ctx.addIssue({
          code: "custom",
          path: at("endMs"),
          message: "segment ends after the transcript duration",
        });
      }
      segment.tokens?.forEach((token, t) => {
        if (token.endMs < token.startMs) {
          ctx.addIssue({
            code: "custom",
            path: ["segments", i, "tokens", t, "endMs"],
            message: "token endMs must not be before startMs",
          });
        }
      });
    });
  });

export type Token = z.infer<typeof TokenSchema>;
export type Segment = z.infer<typeof SegmentSchema>;
export type TranscriptProvenance = z.infer<typeof TranscriptProvenanceSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
