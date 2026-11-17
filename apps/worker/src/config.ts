export const CANVAS_SIZE = 1024;

/** A positive number from an environment variable, or `fallback` when it is unset or invalid. */
export function envNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const MEDIUM = "acrylic";
export const MEDIUM_DESCRIPTION =
  "Acrylic paint. Dries fast: each stroke lands on dry paint. Layers cleanly: an opaque stroke covers what is underneath. " +
  "`opacity` caps how opaque one stroke can get; `flow` is how much paint each pass deposits, building up toward that cap. " +
  "Use high opacity (0.9+) and flow (0.8+) for solid coverage; lower values for glazes and translucent layers.";

/**
 * Default cap on paintings in progress at once (override with MAX_ACTIVE_PAINTINGS).
 * Each painting being worked on holds a ~10 MB canvas, and paintings can share a
 * 128 MB isolate, so keep this modest.
 */
export const DEFAULT_MAX_ACTIVE_PAINTINGS = 6;

/** How long an assignment reserves its painting, so concurrent agents don't collide. */
export const LEASE_MS = 3 * 60_000;
/** Assignment tokens expire after this long. */
export const TOKEN_TTL_MS = 10 * 60_000;
/** Done pool paintings read as archived after this long. */
export const ARCHIVE_AFTER_MS = 5 * 60_000;
/**
 * Free a painting's canvas (~10 MB of WASM memory) after this many seconds without
 * requests. CANVAS_IDLE_SECONDS overrides it (mainly for testing).
 */
export const DEFAULT_CANVAS_IDLE_SECONDS = 10 * 60;
/** JPEG quality for snapshots (the canvas weave makes PNGs ~8x larger). */
export const SNAPSHOT_QUALITY = 90;
/** Persist a paint-buffer checkpoint every N strokes (and on completion). */
export const CHECKPOINT_EVERY = 20;

// --- Created paintings (POST /api/paintings) ---

/** Canvas sizes for created paintings. A study is half the width, about a quarter of the strokes. */
export const SIZES = { full: 1024, study: 512 } as const;
export type SizeName = keyof typeof SIZES;
/** Upper bound on a created painting's stroke budget. */
export const MAX_STROKES_LIMIT = 2000;
/** Default cap on created paintings in progress at once (override with MAX_CREATED_PAINTINGS). */
export const DEFAULT_MAX_CREATED_PAINTINGS = 100;
/** A created painting that receives no stroke within this long expires. */
export const UNPAINTED_EXPIRY_MS = 60 * 60_000;

/**
 * A created painting with no stroke for this many seconds is finished as it stands.
 * CREATED_IDLE_SECONDS overrides it (mainly for testing).
 */
export const DEFAULT_CREATED_IDLE_SECONDS = 6 * 60 * 60;

export function createdIdleMs(env: { CREATED_IDLE_SECONDS?: string }): number {
  return envNumber(env.CREATED_IDLE_SECONDS, DEFAULT_CREATED_IDLE_SECONDS) * 1000;
}

/** Default cap on one client's created paintings in progress (override with MAX_CREATED_PER_CLIENT). */
export const DEFAULT_MAX_CREATED_PER_CLIENT = 30;
/** Most strokes one submit_stroke call may carry. */
export const MAX_BATCH = 50;
/** Longest painter note kept per stroke. */
export const NOTE_MAX = 280;

/**
 * How long an assignment's token stays valid: long enough for a model to plan a large
 * batch before its first submit. Refreshed after every accepted batch.
 */
export function assignmentTtlMs(strokesRemaining: number): number {
  return Math.min(2 * 60 * 60_000, TOKEN_TTL_MS + strokesRemaining * 30_000);
}
