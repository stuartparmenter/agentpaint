export const CANVAS_SIZE = 1024;
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
/** Done paintings become archived after this long. */
export const ARCHIVE_AFTER_MS = 5 * 60_000;
/** Free a painting's canvas (~10 MB of WASM memory) after this long without requests. */
export const CANVAS_IDLE_MS = 10 * 60_000;
/** JPEG quality for snapshots (the canvas weave makes PNGs ~8x larger). */
export const SNAPSHOT_QUALITY = 90;
/** Persist a paint-buffer checkpoint every N strokes (and on completion). */
export const CHECKPOINT_EVERY = 20;
