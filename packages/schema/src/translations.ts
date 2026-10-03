import { z } from "zod";
import { IdSchema, NonEmptyTextSchema, SchemaVersionSchema } from "./common.ts";

/**
 * Prepared sample translations for the demo. Keyed by segment id and tied to the
 * segment's original text — they do not apply to a learner's corrected text.
 */
export const DemoTranslationsSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  episodeId: IdSchema,
  /** "prepared-sample": written for the demo by a person, not produced by a model. */
  kind: z.literal("prepared-sample"),
  language: z.string().min(2),
  translations: z.record(z.string().min(1), NonEmptyTextSchema),
});

export type DemoTranslations = z.infer<typeof DemoTranslationsSchema>;
