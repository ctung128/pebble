import { z } from "zod";
import { SchemaVersionSchema } from "./common.ts";
import { TranslationHealthSchema } from "./lineTranslation.ts";
import { SpeakerHealthSchema } from "./speakers.ts";

/**
 * Provider readiness (1.5). `ready` is the only usable state; `checking` means the worker is
 * still verifying local files. Older workers omit it: fall back to `available`.
 */
export const ProviderStateSchema = z.enum([
  "ready",
  "checking",
  "environment_missing",
  "models_missing",
  "verification_failed",
  "load_failed",
]);

const ToolSchema = z.object({ available: z.boolean(), version: z.string().min(1).nullable() });

/**
 * Local worker status (1.2). The only filesystem path it may contain is the data directory
 * (1.3, optional), abbreviated with "~", so the local app can explain setup problems.
 */
export const WorkerHealthSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  workerVersion: z.string().min(1),
  status: z.enum(["ok", "degraded"]),
  dataDirWritable: z.boolean(),
  dataDir: z
    .object({
      path: z.string().min(1),
      writable: z.boolean(),
      hint: z.string().min(1).nullable(),
    })
    .optional(),
  tools: z.object({ ffmpeg: ToolSchema, ffprobe: ToolSchema }),
  providers: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.enum(["mock", "asr"]),
      available: z.boolean(),
      /** Developer diagnostics; not meant as the primary learner-facing message. */
      detail: z.string().min(1).nullable(),
      state: ProviderStateSchema.optional(),
      /** Plain-language remediation safe to show in the app, with at most one command (1.5). */
      hint: z.string().min(1).optional(),
    }),
  ),
  /** Run nonce of a worker started by `npm run pebble:start` (1.6); local lifecycle only. */
  instanceId: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .optional(),
  /**
   * Optional DeepL line translation (1.8). Absent from older workers, which means translation
   * is off (`translationAvailability`).
   */
  translation: TranslationHealthSchema.optional(),
  /** Optional speaker detection (1.9). Absent from older workers, which means unavailable. */
  speakers: SpeakerHealthSchema.optional(),
});

export type WorkerHealth = z.infer<typeof WorkerHealthSchema>;
export type ProviderState = z.infer<typeof ProviderStateSchema>;
