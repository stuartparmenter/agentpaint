import { DurableObject } from "cloudflare:workers";
import {
  CANVAS_IDLE_MS,
  CHECKPOINT_EVERY,
  lookTtlMs,
  MAX_BATCH,
  MEDIUM_DESCRIPTION,
  SNAPSHOT_QUALITY,
  TOKEN_TTL_MS,
  UNPAINTED_EXPIRY_MS,
} from "./config";
import { digestsEqual, makeToken, randomId, sha256Hex, TOKEN_SECRET_LENGTH } from "./ids";
import type { PaintingStats, PaintingStatus, PaintingSummary } from "./registry";
import { Canvas, resetRenderer, validateStroke } from "./renderer";
import { type BatchStrokeInput, checkBounds, normalize, scaledMinBrush } from "./stroke";
import { currentPhase, isStyleName, STYLES, type Style } from "./styles";

/** What one look shows: the canvas, and the reference when the painting has one. */
export interface LookImages {
  reference: Uint8Array | null;
  canvas: Uint8Array;
}

export interface Assignment {
  token: string;
  /** Null when this returns a look that is still open (no new image until its strokes are used). */
  images: LookImages | null;
  metadata: Record<string, unknown>;
}

export type RejectReason =
  | "invalid_token"
  | "token_used"
  | "token_expired"
  | "painting_not_active"
  | "stale_assignment"
  | "brush_too_small"
  | "invalid_stroke"
  | "too_many_strokes"
  | "temporary_failure";

export interface SubmitResult {
  /** True when at least one stroke was applied (or the painting was finished). */
  applied: boolean;
  applied_count: number;
  stroke_count: number;
  max_strokes: number;
  status: PaintingStatus;
  /** Strokes left on this look's token. */
  strokes_remaining: number;
  reason?: RejectReason;
  detail?: string;
  /** Index (in the submitted batch) of the stroke that was rejected. */
  index?: number;
  min_brush_size?: number;
}

/** Self-reported details recorded with a submission (never trusted for anything else). */
export interface SubmitExtras {
  finished?: boolean;
  model?: string;
  effort?: string;
  inputTokens?: number;
  outputTokens?: number;
  promptHash?: string;
}

export interface StrokeLogEntry {
  version: number;
  created_at: number;
  look: number;
  think_ms: number | null;
  score: number | null;
  note: string | null;
  model: string | null;
  effort: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  prompt_hash: string | null;
}

export interface InitCreated {
  agentKeyHash: string;
  ownerKeyHash: string;
  /** Prepared reference (see prepareReference), when the painting has one. */
  referenceGrid: Float32Array | null;
  referenceJpeg: Uint8Array | null;
}

interface Meta extends Record<string, SqlStorageValue> {
  id: string;
  kind: string;
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
  strokes_per_look: number;
  phases: string;
  reference: string | null;
  agent_key_hash: string | null;
  owner_key_hash: string | null;
  looks: number;
}

interface TokenRow extends Record<string, SqlStorageValue> {
  secret: string;
  /** The painting version the token's next stroke must apply to. */
  version: number;
  agent: string;
  /** When the look was taken. */
  created_at: number;
  expires_at: number;
  remaining: number;
  look: number;
}

export function snapshotKey(paintingId: string, version: number) {
  return `paintings/${paintingId}/v${version}.jpg`;
}

export function referenceKey(paintingId: string) {
  return `paintings/${paintingId}/reference.jpg`;
}

function checkpointKey(paintingId: string) {
  return `paintings/${paintingId}/checkpoint.apb`;
}

function styleOf(meta: Meta): Style {
  return STYLES[isStyleName(meta.style) ? meta.style : "figurative"];
}

/**
 * One instance per painting (named by painting id). Requests to a painting are
 * processed here one at a time, and every check-and-apply step below runs
 * without awaiting, so strokes apply strictly in order.
 *
 * Storage is only created by `init`, so requests naming a painting that
 * doesn't exist (e.g. forged tokens) leave nothing behind.
 *
 * Pool paintings hand out a fresh one-stroke look on every assignment.
 * Created paintings ration looks: a look's token allows `strokes_per_look`
 * strokes, and no new image is shown until they are used.
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
  private referenceGrid: Float32Array | null = null;
  private referenceJpeg: Uint8Array | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  /** Create the painting's state from its registry entry (idempotent). */
  async init(summary: PaintingSummary, created: InitCreated | null = null): Promise<void> {
    if (this.meta()) return;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, style TEXT NOT NULL, prompt TEXT, medium TEXT NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL, max_strokes INTEGER NOT NULL,
      status TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER,
      strokes_per_look INTEGER NOT NULL, phases TEXT NOT NULL, reference TEXT,
      agent_key_hash TEXT, owner_key_hash TEXT, looks INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS strokes (
      version INTEGER PRIMARY KEY, data TEXT NOT NULL, agent TEXT, created_at INTEGER NOT NULL,
      look INTEGER NOT NULL DEFAULT 0, think_ms INTEGER, score REAL, note TEXT, model TEXT, effort TEXT,
      input_tokens INTEGER, output_tokens INTEGER, prompt_hash TEXT
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tokens (
      secret TEXT PRIMARY KEY, version INTEGER NOT NULL, agent TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, remaining INTEGER NOT NULL, look INTEGER NOT NULL
    )`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS reference (grid BLOB NOT NULL)");
    this.sql.exec(
      `INSERT INTO meta (id, kind, style, prompt, medium, width, height, max_strokes, status, version, created_at,
        strokes_per_look, phases, reference, agent_key_hash, owner_key_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, ?, ?)`,
      summary.id,
      summary.kind,
      summary.style,
      summary.prompt,
      summary.medium,
      summary.width,
      summary.height,
      summary.maxStrokes,
      summary.createdAt,
      summary.strokesPerLook,
      summary.phases,
      summary.reference,
      created?.agentKeyHash ?? null,
      created?.ownerKeyHash ?? null,
    );
    if (created?.referenceGrid) {
      this.sql.exec("INSERT INTO reference (grid) VALUES (?)", created.referenceGrid.buffer);
      this.referenceGrid = created.referenceGrid;
    }
    await this.track(async () => {
      if (created?.referenceJpeg) {
        this.referenceJpeg = created.referenceJpeg;
        await this.env.SNAPSHOTS.put(referenceKey(summary.id), created.referenceJpeg, {
          httpMetadata: { contentType: "image/jpeg" },
        });
      }
      await this.ensureLoaded();
      if (this.latestImage) this.v0Stored = await this.putSnapshot(summary.id, 0, this.latestImage);
    });
  }

  /** Check a created painting's agent key (constant time on the digests). */
  async verifyAgentKey(key: string): Promise<boolean> {
    const expected = this.meta()?.agent_key_hash;
    const actual = await sha256Hex(key);
    return !!expected && digestsEqual(actual, expected);
  }

  /** End a created painting early, given its owner key. */
  async finishByOwner(key: string): Promise<boolean> {
    const expected = this.meta()?.owner_key_hash;
    const actual = await sha256Hex(key);
    if (!expected || !digestsEqual(actual, expected)) return false;
    const meta = this.meta() as Meta;
    if (meta.status === "active") {
      this.sql.exec("UPDATE meta SET status = 'done', finished_at = ?", Date.now());
      this.sql.exec("UPDATE tokens SET remaining = 0");
      await this.track(async () => {
        if (this.canvas) await this.putCheckpoint(meta.id, this.canvas);
        await this.reportStats(Date.now());
        this.unload();
      });
    }
    return true;
  }

  async assign(agent: string): Promise<Assignment | { available: false; status: PaintingStatus } | null> {
    const initial = this.meta();
    if (!initial) return null;
    // Never load a canvas for a painting that can't be painted.
    if (initial.status !== "active") return { available: false, status: initial.status as PaintingStatus };
    return this.track(async () => {
      await this.ensureLoaded();
      const meta = this.meta();
      if (meta?.status !== "active" || !this.latestImage) return null;
      const now = Date.now();
      this.sql.exec("DELETE FROM tokens WHERE expires_at < ?", now - TOKEN_TTL_MS);

      if (meta.kind === "created") {
        // Rationing: while the current look still has strokes, hand back the same
        // token without a new image. Anyone calling get_assignment gets it, so a
        // lost token never blocks the painting.
        const open = this.sql
          .exec<TokenRow>(
            `SELECT * FROM tokens WHERE remaining > 0 AND expires_at > ? AND version = ?
             ORDER BY created_at DESC LIMIT 1`,
            now,
            meta.version,
          )
          .toArray()[0];
        if (open) {
          return {
            token: makeToken(meta.id, open.secret),
            images: null,
            metadata: this.metadata(meta, open, false),
          };
        }
      }

      const allowance =
        meta.kind === "created" ? Math.min(meta.strokes_per_look, meta.max_strokes - meta.version) : 1;
      const look = meta.looks + 1;
      const token: TokenRow = {
        secret: randomId(TOKEN_SECRET_LENGTH),
        version: meta.version,
        agent,
        created_at: now,
        expires_at: now + (meta.kind === "created" ? lookTtlMs(allowance) : TOKEN_TTL_MS),
        remaining: allowance,
        look,
      };
      this.sql.exec(
        "INSERT INTO tokens (secret, version, agent, created_at, expires_at, remaining, look) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ...Object.values(token),
      );
      this.sql.exec("UPDATE meta SET looks = ?", look);

      const canvas = this.latestImage;
      // The gallery's history starts at v0; retry it if init couldn't store it.
      if (meta.version === 0 && !this.v0Stored) this.v0Stored = await this.putSnapshot(meta.id, 0, canvas);
      const reference = meta.reference ? await this.loadReferenceJpeg(meta.id) : null;
      return {
        token: makeToken(meta.id, token.secret),
        images: { reference, canvas },
        metadata: this.metadata({ ...meta, looks: look }, token, true),
      };
    });
  }

  async submit(
    secret: string,
    strokes: BatchStrokeInput[],
    agent: string,
    extras: SubmitExtras = {},
  ): Promise<SubmitResult> {
    // Reject bad tokens before loading anything, so they can't pull canvases into memory.
    const early = this.checkToken(secret, agent, strokes.length, extras.finished === true);
    if (early) return early;

    return this.track(async () => {
      await this.ensureLoaded();

      // Re-check after the await (another stroke may have landed), then validate
      // the whole batch and apply it synchronously so nothing can interleave.
      const rejected = this.checkToken(secret, agent, strokes.length, extras.finished === true);
      if (rejected) return rejected;
      const meta = this.meta() as Meta;
      const token = this.token(secret) as TokenRow;
      const canvas = this.canvas;
      if (!canvas) return this.result(meta, token, 0, { reason: "painting_not_active" });

      const style = styleOf(meta);
      const prepared: string[] = [];
      for (const [i, stroke] of strokes.entries()) {
        const bounds = checkBounds(stroke, meta.width, meta.height);
        if (bounds)
          return this.result(meta, token, 0, { reason: "invalid_stroke", detail: bounds, index: i });
        if (meta.phases === "enforced") {
          const phase = currentPhase(style, meta.version + i, meta.max_strokes);
          const floor = scaledMinBrush(phase.minBrushSize, meta.width);
          if (stroke.brush.size < floor) {
            return this.result(meta, token, 0, {
              reason: "brush_too_small",
              detail: `Phase '${phase.name}' requires brush.size >= ${floor}, got ${stroke.brush.size}.`,
              index: i,
              min_brush_size: floor,
            });
          }
        }
        const data = JSON.stringify(normalize(stroke, meta.width, meta.height));
        try {
          validateStroke(data);
        } catch (e) {
          return this.result(meta, token, 0, {
            reason: "invalid_stroke",
            detail: e instanceof Error ? e.message : String(e),
            index: i,
          });
        }
        prepared.push(data);
      }

      const now = Date.now();
      const thinkMs = now - token.created_at;
      const grid = this.reference();
      const images: { version: number; image: Uint8Array }[] = [];
      let fault: string | null = null;
      for (const [i, data] of prepared.entries()) {
        const version = meta.version + 1;
        let image: Uint8Array;
        let score: number | null = null;
        try {
          canvas.applyStroke(data, version);
          image = canvas.renderJpeg(SNAPSHOT_QUALITY);
          if (grid) score = canvas.score(grid);
        } catch (e) {
          // The stroke was valid, so this is a renderer fault. The canvas may be
          // half-painted; drop it so it rebuilds from storage, which has every
          // stroke applied before this one and none after.
          this.renderFault(meta.id, e);
          fault = "The renderer hit an error. Strokes before this one were applied; submit the rest again.";
          break;
        }
        // Token counts describe the whole submission; record them once.
        this.sql.exec(
          `INSERT INTO strokes (version, data, agent, created_at, look, think_ms, score, note, model, effort,
            input_tokens, output_tokens, prompt_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          version,
          data,
          agent,
          now,
          token.look,
          thinkMs,
          score,
          strokes[i]?.note ?? null,
          extras.model ?? null,
          extras.effort ?? null,
          i === 0 ? (extras.inputTokens ?? null) : null,
          i === 0 ? (extras.outputTokens ?? null) : null,
          extras.promptHash ?? null,
        );
        meta.version = version;
        token.version = version;
        token.remaining -= 1;
        images.push({ version, image });
        this.latestImage = image;
      }

      const applied = images.length;
      const finishing = !fault && extras.finished === true;
      const status: PaintingStatus = finishing || meta.version >= meta.max_strokes ? "done" : "active";
      this.sql.exec(
        "UPDATE meta SET version = ?, status = ?, finished_at = CASE WHEN ? = 'done' THEN ? ELSE finished_at END",
        meta.version,
        status,
        status,
        now,
      );
      this.sql.exec(
        "UPDATE tokens SET version = ?, remaining = ?, expires_at = ? WHERE secret = ?",
        token.version,
        status === "done" ? 0 : token.remaining,
        now + (meta.kind === "created" ? lookTtlMs(token.remaining) : TOKEN_TTL_MS),
        secret,
      );
      meta.status = status;
      if (status === "done") token.remaining = 0;

      // Persistence and bookkeeping. A failure here doesn't undo the strokes:
      // they are recorded above and replay from storage.
      for (const { version, image } of images) await this.putSnapshot(meta.id, version, image);
      if (this.canvas && (status === "done" || meta.version - this.checkpointVersion >= CHECKPOINT_EVERY)) {
        await this.putCheckpoint(meta.id, this.canvas);
      }
      await this.reportStats(now);
      if (status === "done") this.unload();
      return this.result(meta, token, applied, fault ? { reason: "temporary_failure", detail: fault } : {});
    });
  }

  /** Current status and stroke count, or null if this painting was never created. */
  async state(): Promise<{ status: PaintingStatus; strokeCount: number } | null> {
    const meta = this.meta();
    return meta ? { status: meta.status as PaintingStatus, strokeCount: meta.version } : null;
  }

  /**
   * Replay check, for the owner: rebuild the canvas from an empty canvas and from
   * the latest checkpoint (replaying the stroke log with seed = version) and
   * compare each result, byte for byte, with the stored snapshot of the latest stroke.
   */
  async verifyReplay(
    ownerKey: string,
  ): Promise<{ version: number; fromScratch: boolean; fromCheckpoint: boolean | null } | null> {
    const meta = this.meta();
    const expected = meta?.owner_key_hash;
    if (!meta || !expected || !digestsEqual(await sha256Hex(ownerKey), expected)) return null;
    const stored = await this.env.SNAPSHOTS.get(snapshotKey(meta.id, meta.version));
    const storedBytes = stored ? new Uint8Array(await stored.arrayBuffer()) : null;
    const strokes = this.sql
      .exec<{ version: number; data: string }>(
        "SELECT version, data FROM strokes WHERE version <= ? ORDER BY version",
        meta.version,
      )
      .toArray();
    const sameAsStored = (canvas: Canvas) => {
      try {
        for (const s of strokes) if (s.version > canvas.version) canvas.applyStroke(s.data, s.version);
        const image = canvas.renderJpeg(SNAPSHOT_QUALITY);
        return (
          !!storedBytes && image.length === storedBytes.length && image.every((b, i) => b === storedBytes[i])
        );
      } finally {
        canvas.free();
      }
    };
    const fromScratch = sameAsStored(new Canvas(meta.width, meta.height));
    let fromCheckpoint: boolean | null = null;
    const checkpoint = await this.env.SNAPSHOTS.get(checkpointKey(meta.id));
    if (checkpoint) {
      fromCheckpoint = sameAsStored(
        Canvas.fromCheckpoint(new Uint8Array(await checkpoint.arrayBuffer()), meta.width, meta.height),
      );
    }
    return { version: meta.version, fromScratch, fromCheckpoint };
  }

  /** The public stroke log. */
  async strokeLog(): Promise<StrokeLogEntry[] | null> {
    if (!this.meta()) return null;
    return this.sql
      .exec<StrokeLogEntry & Record<string, SqlStorageValue>>(
        `SELECT version, created_at, look, think_ms, score, note, model, effort, input_tokens, output_tokens,
          prompt_hash FROM strokes ORDER BY version`,
      )
      .toArray();
  }

  /** Frees an idle canvas, and expires created paintings that were never painted. */
  async alarm(): Promise<void> {
    const meta = this.meta();
    if (!meta) return;
    const now = Date.now();
    if (meta.kind === "created" && meta.status === "active" && meta.version === 0) {
      if (now >= meta.created_at + UNPAINTED_EXPIRY_MS && this.inflight === 0) {
        this.sql.exec("UPDATE meta SET status = 'expired', finished_at = ?", now);
        this.sql.exec("UPDATE tokens SET remaining = 0");
        await this.reportStats(now);
        this.unload();
        return;
      }
    }
    if (this.canvas) {
      const idleFor = now - this.lastActivity;
      if (this.inflight === 0 && !this.loading && idleFor >= this.idleMs()) {
        const canvas = this.canvas;
        try {
          if (canvas.version > this.checkpointVersion) {
            // Save progress first so the next load replays few strokes.
            await this.putCheckpoint(meta.id, canvas);
          }
        } catch (e) {
          console.error("idle checkpoint failed", meta.id, e); // e.g. stale after a renderer reset
        }
        if (this.inflight === 0 && this.canvas === canvas) {
          console.log("unloading idle canvas", meta.id);
          this.unload();
        }
      }
    }
    await this.scheduleAlarm();
  }

  private metadata(meta: Meta, token: TokenRow, newLook: boolean): Record<string, unknown> {
    const style = styleOf(meta);
    const fields: Record<string, unknown> = {
      token: makeToken(meta.id, token.secret),
      prompt: meta.prompt,
      canvas_width: meta.width,
      canvas_height: meta.height,
      medium: meta.medium,
      medium_description: MEDIUM_DESCRIPTION,
      style: style.name,
      stroke_count: meta.version,
      max_strokes: meta.max_strokes,
    };
    if (meta.phases !== "off") {
      const phase = currentPhase(style, meta.version, meta.max_strokes);
      fields.phase = phase.name;
      fields.phase_guidance = phase.guidance;
      if (meta.phases === "enforced") fields.min_brush_size = scaledMinBrush(phase.minBrushSize, meta.width);
    }
    fields.expires_in_seconds = Math.max(0, Math.round((token.expires_at - Date.now()) / 1000));
    if (meta.kind === "created") {
      fields.look = token.look;
      fields.strokes_per_look = meta.strokes_per_look;
      fields.strokes_remaining = token.remaining;
      // false: this look was already open; no new image until its strokes are used.
      fields.new_look = newLook;
      fields.has_reference = meta.reference !== null;
    }
    return fields;
  }

  private result(
    meta: Meta,
    token: TokenRow | undefined,
    applied: number,
    extra: Partial<SubmitResult>,
  ): SubmitResult {
    return {
      applied: applied > 0 || (extra.reason === undefined && meta.status === "done"),
      applied_count: applied,
      stroke_count: meta.version,
      max_strokes: meta.max_strokes,
      status: meta.status as PaintingStatus,
      strokes_remaining: token?.remaining ?? 0,
      ...extra,
    };
  }

  /** Validates a token for submitting `count` strokes; returns a rejection, or null. */
  private checkToken(secret: string, agent: string, count: number, finishing: boolean): SubmitResult | null {
    const meta = this.meta();
    const reject = (reason: RejectReason, detail?: string): SubmitResult => ({
      applied: false,
      applied_count: 0,
      stroke_count: meta?.version ?? 0,
      max_strokes: meta?.max_strokes ?? 0,
      status: (meta?.status ?? "active") as PaintingStatus,
      strokes_remaining: 0,
      reason,
      ...(detail ? { detail } : {}),
    });
    if (!meta) return reject("invalid_token");
    const token = this.token(secret);
    if (!token || token.agent !== agent) return reject("invalid_token");
    if (token.remaining <= 0) return reject("token_used");
    if (token.expires_at <= Date.now()) return reject("token_expired");
    if (meta.status !== "active") return reject("painting_not_active");
    if (token.version !== meta.version) {
      return reject(
        "stale_assignment",
        "Another stroke landed since this look. Call get_assignment for the current canvas.",
      );
    }
    const allowed = Math.min(token.remaining, MAX_BATCH);
    if (count > allowed) {
      return {
        ...reject("too_many_strokes", `This token allows ${allowed} more stroke(s) in one submission.`),
        strokes_remaining: token.remaining,
      };
    }
    if (count === 0 && !(finishing && meta.kind === "created")) {
      return {
        ...reject("invalid_stroke", "Submit at least one stroke."),
        strokes_remaining: token.remaining,
      };
    }
    return null;
  }

  private token(secret: string): TokenRow | undefined {
    return this.sql.exec<TokenRow>("SELECT * FROM tokens WHERE secret = ?", secret).toArray()[0];
  }

  /** The reference grid, loaded from storage on first use. */
  private reference(): Float32Array | null {
    if (!this.referenceGrid) {
      const row = this.sql.exec<{ grid: ArrayBuffer }>("SELECT grid FROM reference").toArray()[0];
      if (row) this.referenceGrid = new Float32Array(row.grid);
    }
    return this.referenceGrid;
  }

  private async loadReferenceJpeg(id: string): Promise<Uint8Array | null> {
    if (!this.referenceJpeg) {
      const object = await this.env.SNAPSHOTS.get(referenceKey(id));
      if (object) this.referenceJpeg = new Uint8Array(await object.arrayBuffer());
    }
    return this.referenceJpeg;
  }

  /** Send the registry this painting's current results (absolute values). */
  private async reportStats(at: number) {
    const meta = this.meta();
    if (!meta) return;
    const agg = this.sql
      .exec<{
        mean_think: number | null;
        tin: number | null;
        tout: number | null;
        last_score: number | null;
      }>(
        `SELECT AVG(think_ms) AS mean_think, SUM(input_tokens) AS tin, SUM(output_tokens) AS tout,
          (SELECT score FROM strokes ORDER BY version DESC LIMIT 1) AS last_score FROM strokes`,
      )
      .one();
    const models = this.sql
      .exec<{ model: string }>("SELECT DISTINCT model FROM strokes WHERE model IS NOT NULL ORDER BY model")
      .toArray()
      .map((r) => r.model);
    const stats: PaintingStats = {
      strokeCount: meta.version,
      status: meta.status as PaintingStatus,
      at,
      lastScore: agg.last_score,
      looks: meta.looks,
      meanThinkMs: agg.mean_think,
      tokensIn: agg.tin ?? 0,
      tokensOut: agg.tout ?? 0,
      models,
    };
    try {
      await this.env.REGISTRY.getByName("registry").recordStroke(meta.id, stats);
    } catch (e) {
      console.error("registry update failed", meta.id, meta.version, e);
    }
  }

  /** Runs a request body, recording activity and scheduling the alarm. */
  private async track<T>(work: () => Promise<T>): Promise<T> {
    this.inflight++;
    try {
      return await work();
    } finally {
      this.inflight--;
      this.lastActivity = Date.now();
      await this.scheduleAlarm();
    }
  }

  /** One alarm serves both the idle unload and the unpainted expiry; set it for whichever is due first. */
  private async scheduleAlarm() {
    const meta = this.meta();
    if (!meta) return;
    const due: number[] = [];
    if (this.canvas) due.push(this.lastActivity + this.idleMs());
    if (meta.kind === "created" && meta.status === "active" && meta.version === 0) {
      due.push(meta.created_at + UNPAINTED_EXPIRY_MS);
    }
    if (due.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, Math.min(...due)));
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
