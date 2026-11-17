import { DurableObject } from "cloudflare:workers";
import {
  CANVAS_IDLE_MS,
  CHECKPOINT_EVERY,
  MEDIUM_DESCRIPTION,
  SNAPSHOT_QUALITY,
  TOKEN_TTL_MS,
} from "./config";
import { makeToken, randomId, TOKEN_SECRET_LENGTH } from "./ids";
import type { PaintingStatus, PaintingSummary } from "./registry";
import { Canvas, resetRenderer, validateStroke } from "./renderer";
import { checkBounds, normalize, type StrokeInput } from "./stroke";
import { currentPhase, isStyleName, STYLES, type StyleName } from "./styles";

export interface Assignment {
  token: string;
  /** The current canvas as a JPEG. */
  image: Uint8Array;
  metadata: {
    token: string;
    prompt: string | null;
    canvas_width: number;
    canvas_height: number;
    medium: string;
    medium_description: string;
    style: StyleName;
    stroke_count: number;
    max_strokes: number;
    phase: string;
    phase_guidance: string;
    min_brush_size: number;
    expires_in_seconds: number;
  };
}

export type SubmitResult =
  | { applied: true; stroke_count: number; max_strokes: number; status: PaintingStatus }
  | { applied: false; reason: RejectReason; detail?: string; min_brush_size?: number };

export type RejectReason =
  | "invalid_token"
  | "token_used"
  | "token_expired"
  | "painting_not_active"
  | "stale_assignment"
  | "brush_too_small"
  | "invalid_stroke"
  | "temporary_failure";

interface Meta extends Record<string, SqlStorageValue> {
  id: string;
  style: string;
  prompt: string | null;
  medium: string;
  width: number;
  height: number;
  max_strokes: number;
  status: string;
  version: number;
  created_at: number;
  finished_at: number | null;
}

interface TokenRow extends Record<string, SqlStorageValue> {
  secret: string;
  version: number;
  agent: string;
  created_at: number;
  used: number;
}

export function snapshotKey(paintingId: string, version: number) {
  return `paintings/${paintingId}/v${version}.jpg`;
}

function checkpointKey(paintingId: string) {
  return `paintings/${paintingId}/checkpoint.apb`;
}

/**
 * One instance per painting (named by painting id). Requests to a painting are
 * processed here one at a time, and every check-and-apply step below runs
 * without awaiting, so strokes apply strictly in order.
 *
 * Storage is only created by `init`, so requests naming a painting that
 * doesn't exist (e.g. forged tokens) leave nothing behind.
 */
export class Painting extends DurableObject<Env> {
  private sql: SqlStorage;
  private canvas: Canvas | null = null;
  /** Stroke count captured by the latest checkpoint in R2. */
  private checkpointVersion = 0;
  private latestImage: Uint8Array | null = null;
  private loading: Promise<void> | null = null;
  /** Requests in progress; the idle alarm never frees the canvas under one. */
  private inflight = 0;
  private lastActivity = 0;
  /** Whether the blank starting snapshot (v0) is known to be in R2. */
  private v0Stored = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  /** Create the painting's state from its registry entry (idempotent). */
  async init(summary: PaintingSummary): Promise<void> {
    if (this.meta()) return;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (
      id TEXT PRIMARY KEY, style TEXT NOT NULL, prompt TEXT, medium TEXT NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL, max_strokes INTEGER NOT NULL,
      status TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS strokes (
      version INTEGER PRIMARY KEY, data TEXT NOT NULL, agent TEXT, created_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tokens (
      secret TEXT PRIMARY KEY, version INTEGER NOT NULL, agent TEXT NOT NULL,
      created_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec(
      `INSERT INTO meta (id, style, prompt, medium, width, height, max_strokes, status, version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?)`,
      summary.id,
      summary.style,
      summary.prompt,
      summary.medium,
      summary.width,
      summary.height,
      summary.maxStrokes,
      summary.createdAt,
    );
    await this.track(async () => {
      await this.ensureLoaded();
      if (this.latestImage) this.v0Stored = await this.putSnapshot(summary.id, 0, this.latestImage);
    });
  }

  async assign(agent: string): Promise<Assignment | null> {
    // Never load a canvas for a painting that can't be painted.
    if (this.meta()?.status !== "active") return null;
    return this.track(async () => {
      await this.ensureLoaded();
      const meta = this.meta();
      if (meta?.status !== "active" || !this.latestImage) return null;

      const now = Date.now();
      this.sql.exec("DELETE FROM tokens WHERE created_at < ?", now - TOKEN_TTL_MS);
      const secret = randomId(TOKEN_SECRET_LENGTH);
      this.sql.exec(
        "INSERT INTO tokens (secret, version, agent, created_at) VALUES (?, ?, ?, ?)",
        secret,
        meta.version,
        agent,
        now,
      );

      const image = this.latestImage;
      // The gallery's history starts at v0; retry it if init couldn't store it.
      if (meta.version === 0 && !this.v0Stored) this.v0Stored = await this.putSnapshot(meta.id, 0, image);

      const style = STYLES[isStyleName(meta.style) ? meta.style : "figurative"];
      const phase = currentPhase(style, meta.version);
      const token = makeToken(meta.id, secret);
      return {
        token,
        image,
        metadata: {
          token,
          prompt: meta.prompt,
          canvas_width: meta.width,
          canvas_height: meta.height,
          medium: meta.medium,
          medium_description: MEDIUM_DESCRIPTION,
          style: style.name,
          stroke_count: meta.version,
          max_strokes: meta.max_strokes,
          phase: phase.name,
          phase_guidance: phase.guidance,
          min_brush_size: phase.minBrushSize,
          expires_in_seconds: TOKEN_TTL_MS / 1000,
        },
      };
    });
  }

  async submit(secret: string, stroke: StrokeInput, agent: string): Promise<SubmitResult> {
    // Reject bad tokens before loading anything, so they can't pull canvases into memory.
    const early = this.checkAssignment(secret, agent);
    if (early) return early;

    return this.track(async () => {
      await this.ensureLoaded();

      // Re-check after the await (another stroke may have landed), then check
      // and apply synchronously so nothing can interleave.
      const rejected = this.checkAssignment(secret, agent);
      if (rejected) return rejected;
      const meta = this.meta() as Meta;
      const canvas = this.canvas;
      if (!canvas) return { applied: false, reason: "painting_not_active" };

      const bounds = checkBounds(stroke, meta.width, meta.height);
      if (bounds) return { applied: false, reason: "invalid_stroke", detail: bounds };
      const style = STYLES[isStyleName(meta.style) ? meta.style : "figurative"];
      const phase = currentPhase(style, meta.version);
      if (stroke.brush.size < phase.minBrushSize) {
        return {
          applied: false,
          reason: "brush_too_small",
          detail: `Phase '${phase.name}' requires brush.size >= ${phase.minBrushSize}, got ${stroke.brush.size}. Use a bigger brush.`,
          min_brush_size: phase.minBrushSize,
        };
      }

      const now = Date.now();
      const version = meta.version + 1;
      const data = JSON.stringify(normalize(stroke, meta.width, meta.height));
      try {
        validateStroke(data);
      } catch (e) {
        return {
          applied: false,
          reason: "invalid_stroke",
          detail: e instanceof Error ? e.message : String(e),
        };
      }
      let image: Uint8Array;
      try {
        canvas.applyStroke(data, version);
        image = canvas.renderJpeg(SNAPSHOT_QUALITY);
      } catch (e) {
        // The stroke was valid, so this is a renderer fault. The canvas may be
        // half-painted; drop it so it rebuilds from storage, which never saw this stroke.
        this.renderFault(meta.id, e);
        return {
          applied: false,
          reason: "temporary_failure",
          detail: "The renderer hit an error. Your token is still valid; submit the stroke again.",
        };
      }
      const status: PaintingStatus = version >= meta.max_strokes ? "done" : "active";
      this.sql.exec(
        "INSERT INTO strokes (version, data, agent, created_at) VALUES (?, ?, ?, ?)",
        version,
        data,
        agent,
        now,
      );
      this.sql.exec(
        "UPDATE meta SET version = ?, status = ?, finished_at = CASE WHEN ? = 'done' THEN ? ELSE finished_at END",
        version,
        status,
        status,
        now,
      );
      this.sql.exec("UPDATE tokens SET used = 1 WHERE secret = ?", secret);
      this.latestImage = image;

      // Persistence and bookkeeping. A failure here doesn't undo the stroke: it is
      // recorded above and replays from storage.
      await this.putSnapshot(meta.id, version, image);
      if (status === "done" || version - this.checkpointVersion >= CHECKPOINT_EVERY) {
        await this.putCheckpoint(meta.id, canvas);
      }
      try {
        await this.env.REGISTRY.getByName("registry").recordStroke(meta.id, version, status, now);
      } catch (e) {
        console.error("registry update failed", meta.id, version, e);
      }
      if (status === "done") this.unload();
      return { applied: true, stroke_count: version, max_strokes: meta.max_strokes, status };
    });
  }

  /** Current status and stroke count, or null if this painting was never created. */
  async state(): Promise<{ status: PaintingStatus; strokeCount: number } | null> {
    const meta = this.meta();
    return meta ? { status: meta.status as PaintingStatus, strokeCount: meta.version } : null;
  }

  /** Frees the canvas once the painting has been idle for a while. */
  async alarm(): Promise<void> {
    if (!this.canvas) return;
    const idleFor = Date.now() - this.lastActivity;
    const idleMs = this.idleMs();
    if (this.inflight > 0 || this.loading || idleFor < idleMs) {
      await this.ctx.storage.setAlarm(Date.now() + Math.max(1000, idleMs - idleFor));
      return;
    }
    const meta = this.meta();
    const canvas = this.canvas;
    try {
      if (meta && canvas.version > this.checkpointVersion) {
        // Save progress first so the next load replays few strokes.
        await this.putCheckpoint(meta.id, canvas);
        if (this.inflight > 0 || this.canvas !== canvas) return; // a request arrived meanwhile
      }
    } catch (e) {
      console.error("idle checkpoint failed", meta?.id, e); // e.g. stale after a renderer reset
    }
    console.log("unloading idle canvas", meta?.id);
    this.unload();
  }

  /** Validates a token for submission; returns a rejection, or null if it may paint. */
  private checkAssignment(secret: string, agent: string): SubmitResult | null {
    const meta = this.meta();
    if (!meta) return { applied: false, reason: "invalid_token" };
    const token = this.sql.exec<TokenRow>("SELECT * FROM tokens WHERE secret = ?", secret).toArray()[0];
    if (!token || token.agent !== agent) return { applied: false, reason: "invalid_token" };
    if (token.used) return { applied: false, reason: "token_used" };
    if (token.created_at < Date.now() - TOKEN_TTL_MS) return { applied: false, reason: "token_expired" };
    if (meta.status !== "active") return { applied: false, reason: "painting_not_active" };
    if (token.version !== meta.version) {
      return {
        applied: false,
        reason: "stale_assignment",
        detail: "Another stroke landed since this assignment. Call get_assignment for the current canvas.",
      };
    }
    return null;
  }

  /** Runs a request body, recording activity and scheduling the idle check. */
  private async track<T>(work: () => Promise<T>): Promise<T> {
    this.inflight++;
    try {
      return await work();
    } finally {
      this.inflight--;
      this.lastActivity = Date.now();
      if (this.canvas) await this.ctx.storage.setAlarm(this.lastActivity + this.idleMs());
    }
  }

  /** CANVAS_IDLE_SECONDS overrides the default (mainly for testing). */
  private idleMs(): number {
    const seconds = Number(this.env.CANVAS_IDLE_SECONDS);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : CANVAS_IDLE_MS;
  }

  private meta(): Meta | undefined {
    const exists = this.sql
      .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
      .toArray().length;
    return exists ? this.sql.exec<Meta>("SELECT * FROM meta").toArray()[0] : undefined;
  }

  /** Recover from a renderer exception: reset the WASM instance if it trapped, drop the canvas. */
  private renderFault(id: string, e: unknown) {
    console.error("renderer fault", id, e);
    if (e instanceof WebAssembly.RuntimeError) {
      // A trap can leave the module's memory inconsistent. Start a fresh
      // instance; canvases held by other paintings in this isolate become stale,
      // fail on their next use and rebuild the same way.
      resetRenderer();
    }
    this.unload();
  }

  private unload() {
    try {
      this.canvas?.free();
    } catch {
      // Stale after a renderer reset; nothing left to free.
    }
    this.canvas = null;
    this.latestImage = null;
    this.loading = null;
  }

  private ensureLoaded(): Promise<void> {
    if (this.canvas) return Promise.resolve();
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** Rebuild the canvas: latest checkpoint from R2, then replay newer strokes. */
  private async load(): Promise<void> {
    const meta = this.meta();
    if (!meta) return;
    let canvas: Canvas | null = null;
    const object = await this.env.SNAPSHOTS.get(checkpointKey(meta.id));
    if (object) {
      try {
        // Dimensions are checked before anything is allocated.
        const restored = Canvas.fromCheckpoint(
          new Uint8Array(await object.arrayBuffer()),
          meta.width,
          meta.height,
        );
        if (restored.version <= meta.version) canvas = restored;
        else restored.free();
      } catch (e) {
        console.error("ignoring unreadable checkpoint", meta.id, e);
      }
    }
    canvas ??= new Canvas(meta.width, meta.height);
    this.checkpointVersion = canvas.version;
    const pending = this.sql
      .exec<{ version: number; data: string }>(
        "SELECT version, data FROM strokes WHERE version > ? ORDER BY version",
        canvas.version,
      )
      .toArray();
    try {
      for (const s of pending) canvas.applyStroke(s.data, s.version);
      this.latestImage = canvas.renderJpeg(SNAPSHOT_QUALITY);
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError) resetRenderer();
      else canvas.free();
      throw e;
    }
    this.canvas = canvas;
  }

  /** Upload a snapshot, retrying once. Returns whether it was stored. */
  private async putSnapshot(id: string, version: number, image: Uint8Array): Promise<boolean> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.env.SNAPSHOTS.put(snapshotKey(id, version), image, {
          httpMetadata: { contentType: "image/jpeg" },
        });
        return true;
      } catch (e) {
        console.error(`snapshot upload failed (attempt ${attempt})`, id, version, e);
      }
    }
    return false;
  }

  private async putCheckpoint(id: string, canvas: Canvas) {
    try {
      const version = canvas.version;
      await this.env.SNAPSHOTS.put(checkpointKey(id), canvas.checkpoint());
      this.checkpointVersion = Math.max(this.checkpointVersion, version);
    } catch (e) {
      console.error("checkpoint upload failed", id, e);
    }
  }
}
