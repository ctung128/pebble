import { z } from "zod";
import { SchemaVersionSchema } from "./common.ts";

const ToolSchema = z.object({ available: z.boolean(), version: z.string().min(1).nullable() });

/** Local worker status (1.2). Never includes filesystem paths. */
export const WorkerHealthSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  workerVersion: z.string().min(1),
  status: z.enum(["ok", "degraded"]),
  dataDirWritable: z.boolean(),
  tools: z.object({ ffmpeg: ToolSchema, ffprobe: ToolSchema }),
  providers: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.enum(["mock", "asr"]),
      available: z.boolean(),
      detail: z.string().min(1).nullable(),
    }),
  ),
});

export type WorkerHealth = z.infer<typeof WorkerHealthSchema>;
