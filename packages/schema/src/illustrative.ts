import { z } from "zod";
import { IdSchema, SchemaVersionSchema } from "./common.ts";

/**
 * Simulated "needs review" flags used only to exercise the uncertainty UI before a real
 * ASR provider supplies meaningful signals. Carries no numeric confidence by design.
 */
export const IllustrativeUncertaintySchema = z.object({
  schemaVersion: SchemaVersionSchema,
  episodeId: IdSchema,
  kind: z.literal("illustrative"),
  purpose: z.string().min(1),
  segments: z.array(z.object({ segmentId: z.string().min(1) })),
});

export type IllustrativeUncertainty = z.infer<typeof IllustrativeUncertaintySchema>;
