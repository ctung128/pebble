import { z } from "zod";
import { AudioProvenanceSchema } from "./manifest.ts";
import {
  IdSchema,
  IsoDateTimeSchema,
  NonEmptyTextSchema,
  SchemaVersionSchema,
  TimeMsSchema,
} from "./common.ts";
import { TranscriptProvenanceSchema } from "./transcript.ts";

/**
 * Something a learner kept. M0B supports whole transcript segments only (`kind: "segment"`);
 * selected phrases may be added later as a new kind with a character range.
 */
export const LearningItemSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: z.string().min(1),
    kind: z.literal("segment"),
    episodeId: IdSchema,
    episodeTitle: NonEmptyTextSchema,
    segmentId: z.string().min(1),
    startMs: TimeMsSchema,
    endMs: TimeMsSchema,
    /** Chinese text as displayed when saved (the correction, if the line was edited). */
    text: NonEmptyTextSchema,
    /** Transcript text before correction; null when the line was not edited. */
    originalText: NonEmptyTextSchema.nullable(),
    /** Pinyin generated for `text`, if pinyin had been generated in the session. */
    pinyin: z.string().min(1).nullable(),
    /** Translation of `text`, if one had been resolved in the session. */
    translation: z.string().min(1).nullable(),
    note: z.string().nullable(),
    savedAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    provenance: z.object({
      transcriptKind: TranscriptProvenanceSchema.shape.kind,
      transcriptProvider: z.string().min(1),
      corrected: z.boolean(),
      audioKind: AudioProvenanceSchema.shape.kind,
    }),
  })
  .superRefine((item, ctx) => {
    if (item.endMs <= item.startMs) {
      ctx.addIssue({ code: "custom", path: ["endMs"], message: "endMs must be after startMs" });
    }
    if (item.provenance.corrected !== (item.originalText !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["originalText"],
        message: "originalText must be set exactly when the item was corrected",
      });
    }
  });

export type LearningItem = z.infer<typeof LearningItemSchema>;
