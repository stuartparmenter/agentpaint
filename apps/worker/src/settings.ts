import * as z from "zod/v4";
import { MAX_STROKES_LIMIT } from "./config";
import { KEY, SERIES_ID } from "./ids";
import { STYLE_NAMES } from "./styles";

// Settings accepted by POST /api/paintings.

export const createInput = z.object({
  style: z.enum(STYLE_NAMES as [string, ...string[]]),
  prompt: z.string().trim().min(1).max(500).nullable().optional(),
  reference: z.string().max(64).nullable().optional(),
  size: z.enum(["full", "study"]).default("full"),
  max_strokes: z.number().int().min(1).max(MAX_STROKES_LIMIT).optional(),
  strokes_per_look: z.number().int().min(1).max(MAX_STROKES_LIMIT).default(1),
  phases: z.enum(["off", "guidance", "enforced"]).default("off"),
  series: z.string().regex(SERIES_ID).optional(),
  series_key: z.string().regex(KEY).optional(),
});

export type CreateInput = z.infer<typeof createInput>;

/** A study's default stroke budget: about a quarter of the style's. */
export function studyBudget(maxStrokes: number): number {
  return Math.max(1, Math.round(maxStrokes / 4));
}
