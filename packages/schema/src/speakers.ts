import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, NonEmptyTextSchema, SchemaVersionSchema } from "./common.ts";

/**
 * Speakers (1.9). Generic, episode-local
 * speaker IDs from a local diarization run (ADR 0009). Payloads carry ids, times, counts and names
 * the learner typed; never transcript text, audio or embeddings. Same rules (paths and messages) as
 * the worker's Pydantic models.
 */

export const MAX_SPEAKER_NAME_CODE_POINTS = 60;
/** Bounds on what a learner can submit (names are user-entered text, not transcript text). */
export const MAX_CORRECTION_SPEAKERS = 200;
export const MAX_CORRECTION_LINES = 20000;
/** A speaker-count hint, when given, is within the clusterer's 1…15 range. */
export const MAX_SPEAKER_COUNT_HINT = 15;
/** Segment ids as keys in speaker payloads: ASCII, so ordering is the same everywhere. */
export const SegmentKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/, "expected a segment id (ASCII, at most 64 characters)");

export const SpeakerIdSchema = z.string().regex(/^S[1-9][0-9]{0,3}$/, "expected a speaker id S1…");
export const SpeakerRunIdSchema = z
  .string()
  .regex(/^spk-[0-9a-f]{12}$/, "expected a speaker run id");

export const SpeakerRunStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const SpeakerFailureCodeSchema = z.enum([
  "SPEAKER_MODEL_UNAVAILABLE",
  "AUDIO_UNAVAILABLE",
  "INVALID_INPUT",
  "EMBEDDING_FAILED",
  "CLUSTERING_FAILED",
  "NETWORK_ISOLATION_FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "WORKER_RESTARTED",
  "CHILD_FAILED",
  "RESULT_INVALID",
  "TRANSCRIPT_CHANGED",
]);

const isSurrogate = (cp: number) => cp >= 0xd800 && cp <= 0xdfff;
const isControl = (cp: number) => cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);

/** A display name the learner typed. Display-only: never part of transcript or DeepL text. */
export const SpeakerNameSchema = z.string().superRefine((name, ctx) => {
  const codePoints = Array.from(name, (char) => char.codePointAt(0) ?? 0);
  const message =
    name.trim().length === 0
      ? "name must not be empty"
      : codePoints.length > MAX_SPEAKER_NAME_CODE_POINTS
        ? `name must be at most ${MAX_SPEAKER_NAME_CODE_POINTS} code points`
        : codePoints.some((cp) => isSurrogate(cp) || isControl(cp))
          ? "name must not contain control characters or unpaired surrogates"
          : name.normalize("NFC") !== name
            ? "name must be NFC-normalized"
            : null;
  if (message) ctx.addIssue({ code: "custom", message });
});

const correctionFields = {
  names: z.record(SpeakerIdSchema, SpeakerNameSchema),
  /** source → target: the source cluster's lines count as the target speaker. */
  merges: z.record(SpeakerIdSchema, SpeakerIdSchema),
  /** Clusters whose lines are not a speaker (e.g. music), shown unassigned. */
  notSpeaker: z.array(SpeakerIdSchema),
  /** Per-line reassignment: a speaker ID, or null for not-a-speaker/unassigned. */
  lines: z.record(SegmentKeySchema, SpeakerIdSchema.nullable()),
};

interface CorrectionFacts {
  names: Record<string, string>;
  merges: Record<string, string>;
  notSpeaker: string[];
  lines: Record<string, string | null>;
}

const speakerOrder = (a: string, b: string) => Number(a.slice(1)) - Number(b.slice(1));
const textOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Run-independent rules, checked in a fixed order so the same corrections always give the same
 * issues: sizes; merges (by speaker number): self, chain or cycle, not-a-speaker; duplicate
 * not-a-speaker entries; names of merged speakers; line targets (by segment id). Checks against a
 * run's own speakers and lines are the worker's. Messages never repeat submitted names.
 */
export function speakerCorrectionIssues(
  c: CorrectionFacts,
  prefix: string[] = [],
): { path: string[]; message: string }[] {
  const issues: { path: string[]; message: string }[] = [];
  const sizes: [string, number, number][] = [
    ["names", Object.keys(c.names).length, MAX_CORRECTION_SPEAKERS],
    ["merges", Object.keys(c.merges).length, MAX_CORRECTION_SPEAKERS],
    ["notSpeaker", c.notSpeaker.length, MAX_CORRECTION_SPEAKERS],
    ["lines", Object.keys(c.lines).length, MAX_CORRECTION_LINES],
  ];
  for (const [name, size, limit] of sizes)
    if (size > limit) issues.push({ path: [...prefix, name], message: `at most ${limit} entries` });
  if (issues.length) return issues;
  const notSpeaker = new Set(c.notSpeaker);
  for (const source of Object.keys(c.merges).sort(speakerOrder)) {
    const target = c.merges[source] ?? "";
    const path = [...prefix, "merges", source];
    if (source === target) issues.push({ path, message: "a speaker can't merge into itself" });
    else if (target in c.merges)
      issues.push({ path, message: "merge targets can't be merged (no chains or cycles)" });
    else if (notSpeaker.has(source) || notSpeaker.has(target))
      issues.push({ path, message: "a not-a-speaker cluster can't be merged" });
  }
  const seen = new Set<string>();
  c.notSpeaker.forEach((speaker, i) => {
    if (seen.has(speaker))
      issues.push({ path: [...prefix, "notSpeaker", String(i)], message: "duplicate speaker" });
    seen.add(speaker);
  });
  for (const speaker of Object.keys(c.names).sort(speakerOrder)) {
    if (speaker in c.merges)
      issues.push({
        path: [...prefix, "names", speaker],
        message: "a merged speaker can't be named",
      });
  }
  for (const segment of Object.keys(c.lines).sort(textOrder)) {
    const speaker = c.lines[segment];
    if (speaker != null && (speaker in c.merges || notSpeaker.has(speaker)))
      issues.push({
        path: [...prefix, "lines", segment],
        message:
          "lines can only be reassigned to a speaker that is neither merged nor marked not-a-speaker",
      });
  }
  return issues;
}

const SpeakerCountHintSchema = z.number().int().min(1).max(MAX_SPEAKER_COUNT_HINT);

/** POST /episodes/{id}/speakers: start detection, optionally with a speaker-count hint. */
export const SpeakerRunRequestSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  speakerCount: SpeakerCountHintSchema.nullable().optional(),
});

/** Whether speaker detection can run on this worker (1.9). Never affects health `status`. */
export const SpeakerHealthSchema = z.object({
  state: z.enum(["ready", "model_missing", "model_incomplete", "isolation_unavailable"]),
  hint: NonEmptyTextSchema.nullable(),
});

export const SpeakerCorrectionsRequestSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    episodeId: IdSchema,
    runId: SpeakerRunIdSchema,
    /** The corrections revision this edit was based on (0: none saved yet). */
    revision: z.number().int().nonnegative(),
    ...correctionFields,
  })
  .superRefine((c, ctx) => {
    for (const issue of speakerCorrectionIssues(c)) ctx.addIssue({ code: "custom", ...issue });
  });

const StoredSpeakerCorrectionsSchema = z.object({
  ...correctionFields,
  revision: z.number().int().positive(),
  updatedAt: IsoDateTimeSchema,
});

const count = z.number().int().nonnegative();
const assignmentsSchema = z.record(SegmentKeySchema, SpeakerIdSchema.nullable());

export const EpisodeSpeakersSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    episodeId: IdSchema,
    /** The latest completed run for the current transcript; kept during re-detection. */
    current: z
      .object({
        runId: SpeakerRunIdSchema,
        completedAt: IsoDateTimeSchema,
        provenance: z.object({
          modelId: z.string().min(1),
          modelRevision: z.string().min(1),
          speakerCountHint: SpeakerCountHintSchema.nullable(),
          clustering: z.string().min(1),
          windows: count,
          noiseWindows: count,
          unassignedLines: count,
        }),
        speakers: z.array(z.object({ id: SpeakerIdSchema, lines: count, windows: count })),
        /** The run's original assignments. */
        assignments: assignmentsSchema,
        corrections: StoredSpeakerCorrectionsSchema.nullable(),
        /** Assignments with the corrections applied. */
        effective: assignmentsSchema,
      })
      .nullable(),
    /** The most recent run of any status (may be the current one). */
    latest: z
      .object({
        runId: SpeakerRunIdSchema,
        status: SpeakerRunStatusSchema,
        failure: z
          .object({
            code: SpeakerFailureCodeSchema,
            message: NonEmptyTextSchema,
            retryable: z.boolean(),
          })
          .nullable(),
        createdAt: IsoDateTimeSchema,
        updatedAt: IsoDateTimeSchema,
      })
      .nullable(),
  })
  .superRefine((payload, ctx) => {
    const { current, latest } = payload;
    if (current) {
      const ids = current.speakers.map((s) => s.id);
      if (ids.some((id, i) => id !== `S${i + 1}`))
        ctx.addIssue({
          code: "custom",
          path: ["current", "speakers"],
          message: "speakers must be S1…Sn in order",
        });
      const known = new Set(ids);
      for (const field of ["assignments", "effective"] as const) {
        for (const [segment, speaker] of Object.entries(current[field])) {
          if (speaker !== null && !known.has(speaker))
            ctx.addIssue({
              code: "custom",
              path: ["current", field, segment],
              message: "unknown speaker",
            });
        }
      }
      const assigned = Object.keys(current.assignments).sort().join("\u0000");
      if (Object.keys(current.effective).sort().join("\u0000") !== assigned)
        ctx.addIssue({
          code: "custom",
          path: ["current", "effective"],
          message: "effective must cover exactly the assigned lines",
        });
      if (current.corrections) {
        const hidden = new Set([
          ...Object.keys(current.corrections.merges),
          ...current.corrections.notSpeaker,
        ]);
        for (const segment of Object.keys(current.effective).sort(textOrder)) {
          const speaker = current.effective[segment];
          if (speaker != null && hidden.has(speaker))
            ctx.addIssue({
              code: "custom",
              path: ["current", "effective", segment],
              message: "effective speakers must be visible (not merged away or not-a-speaker)",
            });
        }
        for (const issue of speakerCorrectionIssues(current.corrections, [
          "current",
          "corrections",
        ]))
          ctx.addIssue({ code: "custom", ...issue });
      }
    }
    if (latest && ["failed", "cancelled"].includes(latest.status) !== (latest.failure !== null))
      ctx.addIssue({
        code: "custom",
        path: ["latest", "failure"],
        message: "failure must be set exactly when failed or cancelled",
      });
  });

export type SpeakerCorrectionsRequest = z.infer<typeof SpeakerCorrectionsRequestSchema>;
export type SpeakerRunRequest = z.infer<typeof SpeakerRunRequestSchema>;
export type SpeakerHealth = z.infer<typeof SpeakerHealthSchema>;
export type EpisodeSpeakers = z.infer<typeof EpisodeSpeakersSchema>;
