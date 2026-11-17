// Painting records shared by the registry, the paintings and the API.

import type { SizeName } from "./config";
import type { StyleName } from "./styles";

export type PaintingStatus = "active" | "done" | "archived" | "expired";
/** `pool` paintings are made by the pooled endpoint's leases; `created` ones by POST /api/paintings. */
export type PaintingKind = "pool" | "created";
export type PhaseMode = "off" | "guidance" | "enforced";

export interface PaintingSummary {
  id: string;
  kind: PaintingKind;
  status: PaintingStatus;
  style: StyleName;
  prompt: string | null;
  medium: string;
  width: number;
  height: number;
  strokeCount: number;
  maxStrokes: number;
  createdAt: number;
  lastStrokeAt: number | null;
  finishedAt: number | null;
  /** Created paintings only (pool paintings: null / their fixed defaults). */
  seriesId: string | null;
  size: SizeName | null;
  strokesPerLook: number;
  phases: PhaseMode;
  reference: string | null;
  blankScore: number | null;
  meanColorScore: number | null;
  /** Running results, maintained by the painting after each stroke. */
  lastScore: number | null;
  looks: number;
  meanThinkMs: number | null;
  tokensIn: number;
  tokensOut: number;
  /** Distinct self-reported models (as named in the painter's API responses). */
  models: string[];
}

/** Settings for a painting created through the API. */
export interface CreateSettings {
  style: StyleName;
  prompt: string | null;
  size: SizeName;
  width: number;
  height: number;
  maxStrokes: number;
  strokesPerLook: number;
  phases: PhaseMode;
  reference: string | null;
  blankScore: number | null;
  meanColorScore: number | null;
}

/** Results a painting reports after each stroke (absolute values, so updates are idempotent). */
export interface PaintingStats {
  strokeCount: number;
  status: PaintingStatus;
  at: number;
  lastScore?: number | null;
  looks?: number;
  meanThinkMs?: number | null;
  tokensIn?: number;
  tokensOut?: number;
  models?: string[];
}
