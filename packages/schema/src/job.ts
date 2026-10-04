import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, NonEmptyTextSchema, SchemaVersionSchema } from "./common.ts";

export const JobStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled"]);
export const JobStageSchema = z.enum([
  "probing",
  "normalizing",
  "chunking",
  "transcribing",
  "merging",
]);

export const JobFailureCodeSchema = z.enum([
  "FFMPEG_NOT_FOUND",
  "UNSUPPORTED_MEDIA",
  "NO_AUDIO_STREAM",
  "AUDIO_TOO_LONG",
  "STORAGE_ERROR",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_ERROR",
  "NO_SPEECH_DETECTED",
  "WORKER_RESTARTED",
  "CANCELLED",
  "INTERNAL_ERROR",
]);

export const JobFailureSchema = z.object({
  /** Stage that failed; null when the job never started (e.g. cancelled while queued). */
  stage: JobStageSchema.nullable(),
  code: JobFailureCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  hint: z.string().min(1).nullable(),
});

/** A transcription job on the local worker (1.2). */
export const JobSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: z.string().min(1),
    episodeId: IdSchema,
    /** Shown while the episode isn't readable yet. */
    episodeTitle: NonEmptyTextSchema,
    status: JobStatusSchema,
    /** Current stage while running; the last stage reached otherwise; null before starting. */
    stage: JobStageSchema.nullable(),
    attempt: z.number().int().positive(),
    /** Real chunk counts, known once chunking has finished; null before that. */
    progress: z
      .object({
        completedChunks: z.number().int().nonnegative(),
        totalChunks: z.number().int().positive(),
      })
      .nullable(),
    failure: JobFailureSchema.nullable(),
    provider: z.object({ id: z.string().min(1), kind: z.enum(["mock", "asr"]) }),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .superRefine((job, ctx) => {
    if (job.progress && job.progress.completedChunks > job.progress.totalChunks) {
      ctx.addIssue({
        code: "custom",
        path: ["progress", "completedChunks"],
        message: "completedChunks must not exceed totalChunks",
      });
    }
    const ended = job.status === "failed" || job.status === "cancelled";
    if (ended !== (job.failure !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["failure"],
        message: "failure must be set exactly when the job failed or was cancelled",
      });
    }
  });

export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobStage = z.infer<typeof JobStageSchema>;
export type JobFailure = z.infer<typeof JobFailureSchema>;
export type Job = z.infer<typeof JobSchema>;
