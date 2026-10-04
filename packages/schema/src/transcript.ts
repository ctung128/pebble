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

/**
 * Structural review flags (1.4): non-probabilistic notes about a segment's shape, recorded for
 * review and benchmarking. They are not confidence, never displayed as such, and never used to
 * rewrite text. Thresholds are recorded in `provenance.review.thresholds`.
 */
export const ReviewFlagSchema = z.enum([
  "long_segment",
  "short_fragment",
  "timestamp_alignment_anomaly",
  "speech_gap",
]);

export const SegmentReviewSchema = z.object({ flags: z.array(ReviewFlagSchema) });

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
  /** Worker ASR output (1.4): the 0-based processing chunk that produced this segment. */
  chunkIndex: z.number().int().nonnegative().optional(),
  /** Worker ASR output (1.4): internal structural review metadata. Not confidence. */
  review: SegmentReviewSchema.optional(),
});

/** One pretrained model used to produce an ASR transcript (1.4). */
export const ProvenanceModelSchema = z.object({
  role: z.enum(["asr", "vad", "punctuation"]),
  id: z.string().min(1),
  revision: z.string().min(1),
});

export const ProvenanceReviewSchema = z.object({
  thresholds: z.object({
    longSegmentMs: z.number().int().positive(),
    shortFragmentMs: z.number().int().positive(),
    speechGapMs: z.number().int().positive(),
  }),
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
  /** ASR transcripts (1.4): every model involved, at its exact revision. */
  models: z.array(ProvenanceModelSchema).optional(),
  /** ASR transcripts (1.4): runtime versions and device, e.g. `{ funasr: "1.4.16", device: "cpu" }`. */
  runtime: z.record(z.string().min(1), z.string().min(1)).optional(),
  /** ASR transcripts (1.4): how segment review flags were computed. */
  review: ProvenanceReviewSchema.optional(),
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

export type ReviewFlag = z.infer<typeof ReviewFlagSchema>;
export type ProvenanceModel = z.infer<typeof ProvenanceModelSchema>;
export type Token = z.infer<typeof TokenSchema>;
export type Segment = z.infer<typeof SegmentSchema>;
export type TranscriptProvenance = z.infer<typeof TranscriptProvenanceSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
