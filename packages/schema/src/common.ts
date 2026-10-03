import { z } from "zod";

/** "1.x" — the major is checked separately so callers get a precise error code. */
export const SchemaVersionSchema = z.string().regex(/^1\.\d+$/, "expected schemaVersion 1.x");

export const IdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "ids are lowercase letters, digits and hyphens");

/** A path relative to the payload's own location. No absolute paths, schemes or "..". */
export const RelativePathSchema = z
  .string()
  .regex(/^(?!\/)(?![a-z][a-z0-9+.-]*:)(?!.*\.\.)[\w./-]+$/i, "expected a relative path");

export const IsoDateTimeSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "expected an ISO 8601 date-time");

export const NonEmptyTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "text must not be empty");

export const DurationMsSchema = z.number().int().positive();
export const TimeMsSchema = z.number().int().nonnegative();
