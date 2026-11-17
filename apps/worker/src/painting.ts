import { DurableObject } from "cloudflare:workers";
import {
  assignmentTtlMs,
  CHECKPOINT_EVERY,
  createdIdleMs,
  DEFAULT_CANVAS_IDLE_SECONDS,
  envNumber,
  MAX_BATCH,
  MEDIUM,
  MEDIUM_DESCRIPTION,
  SNAPSHOT_QUALITY,
  TOKEN_TTL_MS,
  UNPAINTED_EXPIRY_MS,
} from "./config";
import { constantTimeEqual, makeToken, randomId, sha256Hex, TOKEN_SECRET_LENGTH } from "./ids";
import { Canvas, resetRenderer, validateStroke } from "./renderer";
import { type BatchStrokeInput, checkBounds, maxBrushSize, normalize } from "./stroke";
import type { PaintingStats, PaintingStatus, PaintingSummary } from "./types";

/** What a new assignment shows: the canvas, and the reference when the painting has one. */
export interface AssignmentImages {
  reference: Uint8Array | null;
  canvas: Uint8Array;
}

/** The fields an assignment sends the painter. */
export type AssignmentMetadata = Record<string, string | number | boolean | null>;

export interface Assignment {
  token: string;
  /** Null when this returns an assignment that is still open (no new image until its strokes are used). */
  images: AssignmentImages | null;
  metadata: AssignmentMetadata;
}

/** What `assign` returns for a painting that can't be painted. */
export interface Unavailable {
  available: false;
  status: PaintingStatus;
  strokeCount: number;
}

export type RejectReason =
  | "invalid_token"
  | "token_used"
  | "token_expired"
  | "painting_not_active"
  | "stale_assignment"
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
  /** Strokes left on this assignment's token. */
  assignment_strokes_remaining: number;
  /** Strokes left in the painting's budget (max_strokes - stroke_count). */
  painting_strokes_remaining: number;
  reason?: RejectReason;
  detail?: string;
  /** Index (in the submitted batch) of the stroke that was rejected. */
  index?: number;
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
  assignment: number;
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
  width: number;
  height: number;
  max_strokes: number;
  status: string;
  version: number;
  created_at: number;
  finished_at: number | null;
  strokes_per_assignment: number;
  reference: string | null;
  agent_key_hash: string | null;
  owner_key_hash: string | null;
  assignments: number;
}

interface TokenRow extends Record<string, SqlStorageValue> {
  secret: string;
  /** The painting version the token's next stroke must apply to. */
  version: number;
  agent: string;
  /** When the assignment was handed out. */
  created_at: number;
  expires_at: number;
  remaining: number;
  assignment: number;
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

/**
 * One instance per painting (named by painting id). Requests to a painting are
 * processed here one at a time, and every check-and-apply step below runs
 * without awaiting, so strokes apply strictly in order.
 *
 * Storage is only created by `init`, so requests naming a painting that
 * doesn't exist (e.g. forged tokens) leave nothing behind.
 *
 * Pool paintings hand out a new one-stroke assignment on every call.
 * Created paintings ration assignments: an assignment's token allows
 * `strokes_per_assignment` strokes, and no new image is shown until they are used.
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
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, style TEXT NOT NULL, prompt TEXT,
      width INTEGER NOT NULL, height INTEGER NOT NULL, max_strokes INTEGER NOT NULL,
      status TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER,
      strokes_per_assignment INTEGER NOT NULL, reference TEXT,
      agent_key_hash TEXT, owner_key_hash TEXT, assignments INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS strokes (
      version INTEGER PRIMARY KEY, data TEXT NOT NULL, agent TEXT, created_at INTEGER NOT NULL,
      assignment INTEGER NOT NULL, think_ms INTEGER, score REAL, note TEXT, model TEXT, effort TEXT,
      input_tokens INTEGER, output_tokens INTEGER, prompt_hash TEXT
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tokens (
      secret TEXT PRIMARY KEY, version INTEGER NOT NULL, agent TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, remaining INTEGER NOT NULL, assignment INTEGER NOT NULL
    )`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS reference (grid BLOB NOT NULL)");
    this.sql.exec(
      `INSERT INTO meta (id, kind, style, prompt, width, height, max_strokes, status, version, created_at,
        strokes_per_assignment, reference, agent_key_hash, owner_key_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, ?)`,
      summary.id,
      summary.kind,
      summary.style,
      summary.prompt,
      summary.width,
      summary.height,
      summary.maxStrokes,
      summary.createdAt,
      summary.strokesPerAssignment,
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

  /** Check a created painting's agent key. */
  async verifyAgentKey(key: string): Promise<boolean> {
    return this.keyMatches(this.meta()?.agent_key_hash, key);
  }

  /** End a created painting early, given its owner key. */
  async finishByOwner(key: string): Promise<boolean> {
    if (!(await this.keyMatches(this.meta()?.owner_key_hash, key))) return false;
    if (this.meta()?.status === "active") await this.track(() => this.end("done", Date.now()));
    return true;
  }

  /**
   * An assignment on the painting, `Unavailable` when it can't be painted, or null when
   * it was never created.
   */
  async assign(agent: string): Promise<Assignment | Unavailable | null> {
    const unavailable = (meta: Meta): Unavailable => ({
      available: false,
      status: meta.status as PaintingStatus,
      strokeCount: meta.version,
    });
    const initial = this.meta();
    if (!initial) return null;
    // Never load a canvas for a painting that can't be painted.
    if (initial.status !== "active") return unavailable(initial);
    return this.track(async () => {
      await this.ensureLoaded();
      const meta = this.meta() as Meta;
      if (meta.status !== "active" || !this.latestImage) return unavailable(meta);
      const now = Date.now();
      this.sql.exec("DELETE FROM tokens WHERE expires_at < ?", now - TOKEN_TTL_MS);

      if (meta.kind === "created") {
        // Rationing: while the current assignment still has strokes, hand back the same
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
        meta.kind === "created" ? Math.min(meta.strokes_per_assignment, meta.max_strokes - meta.version) : 1;
      const number = meta.assignments + 1;
      const token: TokenRow = {
        secret: randomId(TOKEN_SECRET_LENGTH),
        version: meta.version,
        agent,
        created_at: now,
        expires_at: now + (meta.kind === "created" ? assignmentTtlMs(allowance) : TOKEN_TTL_MS),
        remaining: allowance,
        assignment: number,
      };
      this.sql.exec(
        "INSERT INTO tokens (secret, version, agent, created_at, expires_at, remaining, assignment) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ...Object.values(token),
      );
      this.sql.exec("UPDATE meta SET assignments = ?", number);

      const canvas = this.latestImage;
      // The gallery's history starts at v0; retry it if init couldn't store it.
      if (meta.version === 0 && !this.v0Stored) this.v0Stored = await this.putSnapshot(meta.id, 0, canvas);
      const reference = meta.reference ? await this.loadReferenceJpeg(meta.id) : null;
      return {
        token: makeToken(meta.id, token.secret),
        images: { reference, canvas },
        metadata: this.metadata({ ...meta, assignments: number }, token, true),
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

      const prepared: string[] = [];
      for (const [i, stroke] of strokes.entries()) {
        const bounds = checkBounds(stroke, meta.width, meta.height);
        if (bounds)
          return this.result(meta, token, 0, { reason: "invalid_stroke", detail: bounds, index: i });
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
          `INSERT INTO strokes (version, data, agent, created_at, assignment, think_ms, score, note, model, effort,
            input_tokens, output_tokens, prompt_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          version,
          data,
          agent,
          now,
          token.assignment,
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
        now + (meta.kind === "created" ? assignmentTtlMs(token.remaining) : TOKEN_TTL_MS),
        secret,
      );
      meta.status = status;
      if (status === "done") token.remaining = 0;

      // Persistence and bookkeeping. A failure here doesn't undo the strokes:
      // they are recorded above and replay from storage. The registry hears last,
      // so the gallery never lists a stroke whose snapshot isn't stored.
      await Promise.all(images.map(({ version, image }) => this.putSnapshot(meta.id, version, image)));
      if (this.canvas && (status === "done" || meta.version - this.checkpointVersion >= CHECKPOINT_EVERY)) {
        await this.putCheckpoint(meta.id, this.canvas);
      }
      await this.reportStats(now);
      if (status === "done") this.unload();
      return this.result(meta, token, applied, fault ? { reason: "temporary_failure", detail: fault } : {});
    });
  }

  /**
   * Replay check, for the owner: rebuild the canvas the way a load does, from an
   * empty canvas and from the latest checkpoint (replaying the stroke log with
   * seed = version), and compare each result, byte for byte, with the stored
   * snapshot of the latest stroke. `fromCheckpoint` is null when there is no
   * usable checkpoint (a load then starts from scratch).
   */
  async verifyReplay(
    ownerKey: string,
  ): Promise<{ version: number; fromScratch: boolean; fromCheckpoint: boolean | null } | null> {
    const meta = this.meta();
    if (!meta || !(await this.keyMatches(meta.owner_key_hash, ownerKey))) return null;
    const stored = await this.env.SNAPSHOTS.get(snapshotKey(meta.id, meta.version));
    const storedBytes = stored ? new Uint8Array(await stored.arrayBuffer()) : null;
    const sameAsStored = (canvas: Canvas) => {
      const image = this.replayOnto(canvas, meta.version);
      canvas.free();
      return (
        !!storedBytes && image.length === storedBytes.length && image.every((b, i) => b === storedBytes[i])
      );
    };
    const fromScratch = sameAsStored(new Canvas(meta.width, meta.height));
    const checkpoint = await this.readCheckpoint(meta);
    const fromCheckpoint = checkpoint ? sameAsStored(checkpoint) : null;
    return { version: meta.version, fromScratch, fromCheckpoint };
  }

  /** The public stroke log. */
  async strokeLog(): Promise<StrokeLogEntry[] | null> {
    if (!this.meta()) return null;
    return this.sql
      .exec<StrokeLogEntry & Record<string, SqlStorageValue>>(
        `SELECT version, created_at, assignment, think_ms, score, note, model, effort, input_tokens, output_tokens,
          prompt_hash FROM strokes ORDER BY version`,
      )
      .toArray();
  }

  /** Score after each stroke, as [stroke, score] pairs (empty without a reference). */
  async scoreCurve(): Promise<[number, number][]> {
    if (!this.meta()) return [];
    return this.sql
      .exec<{ version: number; score: number }>(
        "SELECT version, score FROM strokes WHERE score IS NOT NULL ORDER BY version",
      )
      .toArray()
      .map((r) => [r.version, r.score]);
  }

  /** Frees an idle canvas, and expires created paintings that were never painted. */
  async alarm(): Promise<void> {
    const meta = this.meta();
    if (!meta) return;
    const now = Date.now();
    if (meta.kind === "created" && meta.status === "active" && meta.version === 0) {
      if (now >= meta.created_at + UNPAINTED_EXPIRY_MS && this.inflight === 0) {
        await this.end("expired", now);
        return;
      }
    }
    const lastStroke = this.lastStrokeAt();
    if (
      meta.kind === "created" &&
      meta.status === "active" &&
      lastStroke !== null &&
      now >= lastStroke + createdIdleMs(this.env) &&
      this.inflight === 0
    ) {
      // Abandoned: finish it as it stands, dated at its last stroke.
      await this.end("done", lastStroke);
      return;
    }
    if (this.canvas) {
      const idleFor = now - this.lastActivity;
      if (this.inflight === 0 && !this.loading && idleFor >= this.idleMs()) {
        const canvas = this.canvas;
        // Save progress first so the next load replays few strokes.
        await this.putCheckpoint(meta.id, canvas);
        if (this.inflight === 0 && this.canvas === canvas) {
          console.log("unloading idle canvas", meta.id);
          this.unload();
        }
      }
    }
    await this.scheduleAlarm();
  }

  private metadata(meta: Meta, token: TokenRow, newAssignment: boolean): AssignmentMetadata {
    const fields: AssignmentMetadata = {
      token: makeToken(meta.id, token.secret),
      painting_id: meta.id,
      prompt: meta.prompt,
      canvas_width: meta.width,
      canvas_height: meta.height,
      max_brush_size: maxBrushSize(meta.width),
      medium: MEDIUM,
      medium_description: MEDIUM_DESCRIPTION,
      style: meta.style,
      stroke_count: meta.version,
      max_strokes: meta.max_strokes,
      painting_strokes_remaining: meta.max_strokes - meta.version,
    };
    fields.expires_in_seconds = Math.max(0, Math.round((token.expires_at - Date.now()) / 1000));
    if (meta.kind === "created") {
      fields.assignment = token.assignment;
      fields.strokes_per_assignment = meta.strokes_per_assignment;
      fields.assignment_strokes_remaining = token.remaining;
      // false: this assignment was already open; no new image until its strokes are used.
      fields.new_assignment = newAssignment;
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
      assignment_strokes_remaining: token?.remaining ?? 0,
      painting_strokes_remaining: meta.max_strokes - meta.version,
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
      assignment_strokes_remaining: 0,
      painting_strokes_remaining: (meta?.max_strokes ?? 0) - (meta?.version ?? 0),
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
        "Another stroke landed after this assignment was handed out. Call get_assignment for the current canvas.",
      );
    }
    const allowed = Math.min(token.remaining, MAX_BATCH);
    if (count > allowed) {
      return {
        ...reject("too_many_strokes", `This token allows ${allowed} more stroke(s) in one submission.`),
        assignment_strokes_remaining: token.remaining,
      };
    }
    if (count === 0 && !(finishing && meta.kind === "created")) {
      return {
        ...reject("invalid_stroke", "Submit at least one stroke."),
        assignment_strokes_remaining: token.remaining,
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
      assignments: meta.assignments,
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

  private lastStrokeAt(): number | null {
    return (
      this.sql
        .exec<{ created_at: number }>("SELECT created_at FROM strokes ORDER BY version DESC LIMIT 1")
        .toArray()[0]?.created_at ?? null
    );
  }

  /**
   * One alarm serves the idle unload, the unpainted expiry and the abandoned
   * finish; set it for whichever is due first.
   */
  private async scheduleAlarm() {
    const meta = this.meta();
    if (!meta) return;
    const due: number[] = [];
    if (this.canvas) due.push(this.lastActivity + this.idleMs());
    if (meta.kind === "created" && meta.status === "active") {
      const lastStroke = this.lastStrokeAt();
      due.push(
        lastStroke === null ? meta.created_at + UNPAINTED_EXPIRY_MS : lastStroke + createdIdleMs(this.env),
      );
    }
    if (due.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, Math.min(...due)));
  }

  private idleMs(): number {
    return envNumber(this.env.CANVAS_IDLE_SECONDS, DEFAULT_CANVAS_IDLE_SECONDS) * 1000;
  }

  /** Whether `key` hashes to `hash` (compared in constant time). */
  private async keyMatches(hash: string | null | undefined, key: string): Promise<boolean> {
    const actual = await sha256Hex(key);
    return !!hash && constantTimeEqual(actual, hash);
  }

  /**
   * End the painting: no token paints again, the canvas is checkpointed if it has
   * unsaved strokes, the registry is told, and the canvas is freed.
   */
  private async end(status: "done" | "expired", finishedAt: number) {
    const meta = this.meta() as Meta;
    this.sql.exec("UPDATE meta SET status = ?, finished_at = ?", status, finishedAt);
    this.sql.exec("UPDATE tokens SET remaining = 0");
    if (this.canvas) await this.putCheckpoint(meta.id, this.canvas);
    await this.reportStats(finishedAt);
    this.unload();
  }

  private hasMeta(): boolean {
    return (
      this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0
    );
  }

  private meta(): Meta | undefined {
    return this.hasMeta() ? this.sql.exec<Meta>("SELECT * FROM meta").toArray()[0] : undefined;
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
    const canvas = (await this.readCheckpoint(meta)) ?? new Canvas(meta.width, meta.height);
    this.checkpointVersion = canvas.version;
    this.latestImage = this.replayOnto(canvas, meta.version);
    this.canvas = canvas;
  }

  /**
   * The latest checkpoint from R2 as a canvas, or null when there is none, it
   * can't be read, or it is ahead of the stroke log.
   */
  private async readCheckpoint(meta: Meta): Promise<Canvas | null> {
    const object = await this.env.SNAPSHOTS.get(checkpointKey(meta.id));
    if (!object) return null;
    try {
      // Dimensions are checked before anything is allocated.
      const restored = Canvas.fromCheckpoint(
        new Uint8Array(await object.arrayBuffer()),
        meta.width,
        meta.height,
      );
      if (restored.version <= meta.version) return restored;
      restored.free();
    } catch (e) {
      console.error("ignoring unreadable checkpoint", meta.id, e);
    }
    return null;
  }

  /**
   * Apply the stored strokes after the canvas's version, up to `upTo`, each with
   * seed = its version, and render the result. On failure the canvas is freed
   * (or the renderer reset, if it trapped) and the error rethrown.
   */
  private replayOnto(canvas: Canvas, upTo: number): Uint8Array {
    const pending = this.sql
      .exec<{ version: number; data: string }>(
        "SELECT version, data FROM strokes WHERE version > ? AND version <= ? ORDER BY version",
        canvas.version,
        upTo,
      )
      .toArray();
    try {
      for (const s of pending) canvas.applyStroke(s.data, s.version);
      return canvas.renderJpeg(SNAPSHOT_QUALITY);
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError) resetRenderer();
      else canvas.free();
      throw e;
    }
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

  /**
   * Upload a checkpoint when the canvas has strokes the latest one lacks. Never
   * throws (e.g. on a canvas left stale by a renderer reset): without a
   * checkpoint, a load replays from scratch.
   */
  private async putCheckpoint(id: string, canvas: Canvas) {
    try {
      const version = canvas.version;
      if (version <= this.checkpointVersion) return;
      await this.env.SNAPSHOTS.put(checkpointKey(id), canvas.checkpoint());
      this.checkpointVersion = Math.max(this.checkpointVersion, version);
    } catch (e) {
      console.error("checkpoint upload failed", id, e);
    }
  }
}
