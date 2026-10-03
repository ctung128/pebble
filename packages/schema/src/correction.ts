import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, NonEmptyTextSchema, SchemaVersionSchema } from "./common.ts";

/** A learner's correction of one transcript segment. The transcript itself is never mutated. */
export const CorrectionSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  episodeId: IdSchema,
  segmentId: z.string().min(1),
  /** The segment text from the transcript at the time of correction. */
  originalText: NonEmptyTextSchema,
  correctedText: NonEmptyTextSchema,
  updatedAt: IsoDateTimeSchema,
});

export type Correction = z.infer<typeof CorrectionSchema>;
