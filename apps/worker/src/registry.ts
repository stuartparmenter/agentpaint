import { DurableObject } from "cloudflare:workers";
import { createdIdleMs, type SizeName } from "./config";
import { constantTimeEqual, KEY_LENGTH, PAINTING_ID_LENGTH, randomId, sha256Hex } from "./ids";
import type { StyleName } from "./styles";
import type { CreateSettings, PaintingStats, PaintingStatus, PaintingSummary } from "./types";

interface Row extends Record<string, SqlStorageValue> {
  id: string;
  status: string;
  style: string;
  prompt: string | null;
  width: number;
  height: number;
  stroke_count: number;
  max_strokes: number;
  created_at: number;
  last_stroke_at: number | null;
  finished_at: number | null;
  series_id: string;
  size: string;
  strokes_per_assignment: number;
  reference: string | null;
  blank_score: number | null;
  mean_color_score: number | null;
  last_score: number | null;
  assignments: number;
  mean_think_ms: number | null;
  tokens_in: number;
  tokens_out: number;
  models: string;
}

function toSummary(r: Row): PaintingSummary {
  return {
    id: r.id,
    status: r.status as PaintingStatus,
    style: r.style as StyleName,
    prompt: r.prompt,
    width: r.width,
    height: r.height,
    strokeCount: r.stroke_count,
    maxStrokes: r.max_strokes,
    createdAt: r.created_at,
    lastStrokeAt: r.last_stroke_at,
    finishedAt: r.finished_at,
    seriesId: r.series_id,
    size: r.size as SizeName,
    strokesPerAssignment: r.strokes_per_assignment,
    reference: r.reference,
    blankScore: r.blank_score,
    meanColorScore: r.mean_color_score,
    lastScore: r.last_score,
    assignments: r.assignments,
    meanThinkMs: r.mean_think_ms,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    models: JSON.parse(r.models) as string[],
  };
}

/** Every column a summary reads (all but the creator's address hash). */
const COLUMNS = `id, status, style, prompt, width, height, stroke_count, max_strokes, created_at, last_stroke_at,
  finished_at, series_id, size, strokes_per_assignment, reference, blank_score, mean_color_score, last_score,
  assignments, mean_think_ms, tokens_in, tokens_out, models`;

export type CreateResult =
  | { ok: true; painting: PaintingSummary; seriesId: string; seriesKey: string | null }
  | {
      ok: false;
      error:
        | "series_not_found"
        | "series_key_mismatch"
        | "too_many_paintings"
        | "too_many_paintings_for_client";
    };

/** Caps on paintings in progress: across all clients, and per client. */
export interface CreatedCaps {
  total: number;
  perClient: number;
}

/**
 * The global index of paintings and their series (a single instance, named
 * "registry").
 */
export class Registry extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS paintings (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      style TEXT NOT NULL,
      prompt TEXT,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      stroke_count INTEGER NOT NULL DEFAULT 0,
      max_strokes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_stroke_at INTEGER,
      finished_at INTEGER,
      series_id TEXT NOT NULL,
      size TEXT NOT NULL,
      strokes_per_assignment INTEGER NOT NULL,
      reference TEXT,
      blank_score REAL,
      mean_color_score REAL,
      last_score REAL,
      assignments INTEGER NOT NULL DEFAULT 0,
      mean_think_ms REAL,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      models TEXT NOT NULL DEFAULT '[]',
      creator TEXT
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS paintings_status ON paintings (status, last_stroke_at)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS paintings_series ON paintings (series_id)");
    // Salt for hashing client addresses; it never leaves this object.
    this.sql.exec("CREATE TABLE IF NOT EXISTS salt (value TEXT NOT NULL)");
    if (!this.sql.exec("SELECT 1 FROM salt").toArray().length) {
      this.sql.exec("INSERT INTO salt (value) VALUES (?)", randomId(KEY_LENGTH));
    }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS series (
      id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
  }

  /**
   * Record a painting created through the API, in a new series or (with that
   * series' key hash) an existing one. Returns the series key only when the
   * series is new. `client` is the caller's address; only a salted hash of it is
   * stored, to apply the per-client cap.
   */
  async createPainting(
    settings: CreateSettings,
    series: { id: string; keyHash: string } | null,
    newSeriesKey: { key: string; keyHash: string },
    client: string,
    caps: CreatedCaps,
  ): Promise<CreateResult> {
    const salt = this.sql.exec<{ value: string }>("SELECT value FROM salt").one().value;
    const creator = await sha256Hex(`${salt}:${client}`);
    const now = Date.now();
    let seriesId: string;
    let seriesKey: string | null = null;
    if (series) {
      const row = this.sql
        .exec<{ key_hash: string }>("SELECT key_hash FROM series WHERE id = ?", series.id)
        .toArray()[0];
      if (!row) return { ok: false, error: "series_not_found" };
      if (!constantTimeEqual(row.key_hash, series.keyHash))
        return { ok: false, error: "series_key_mismatch" };
      seriesId = series.id;
    } else {
      seriesId = randomId(PAINTING_ID_LENGTH);
      seriesKey = newSeriesKey.key;
    }

    // Paintings idle past createdIdleMs are finished by their own alarm; leave
    // them out of the count even if that hasn't happened yet.
    const inProgress = `status = 'active' AND COALESCE(last_stroke_at, created_at) > ?`;
    const since = now - createdIdleMs(this.env);
    const mine = this.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM paintings WHERE ${inProgress} AND creator = ?`,
        since,
        creator,
      )
      .one().n;
    if (mine >= caps.perClient) return { ok: false, error: "too_many_paintings_for_client" };
    const active = this.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM paintings WHERE ${inProgress}`, since)
      .one().n;
    if (active >= caps.total) return { ok: false, error: "too_many_paintings" };

    if (!series) {
      this.sql.exec(
        "INSERT INTO series (id, key_hash, created_at) VALUES (?, ?, ?)",
        seriesId,
        newSeriesKey.keyHash,
        now,
      );
    }
    const id = randomId(PAINTING_ID_LENGTH);
    this.sql.exec(
      `INSERT INTO paintings (id, status, style, prompt, width, height, max_strokes, created_at,
        series_id, size, strokes_per_assignment, reference, blank_score, mean_color_score, creator)
       VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      settings.style,
      settings.prompt,
      settings.width,
      settings.height,
      settings.maxStrokes,
      now,
      seriesId,
      settings.size,
      settings.strokesPerAssignment,
      settings.reference,
      settings.blankScore,
      settings.meanColorScore,
      creator,
    );
    return { ok: true, painting: this.row(id) as PaintingSummary, seriesId, seriesKey };
  }

  /** Called by the painting after each change. */
  async recordStroke(id: string, stats: PaintingStats): Promise<void> {
    // Updates can arrive out of order (each is sent after the stroke's R2
    // writes); never let an older one roll the painting back.
    this.sql.exec(
      `UPDATE paintings SET stroke_count = ?, status = ?, last_stroke_at = CASE WHEN ? > 0 THEN ? ELSE last_stroke_at END,
        finished_at = CASE WHEN ? IN ('done', 'expired') AND finished_at IS NULL THEN ? ELSE finished_at END,
        last_score = COALESCE(?, last_score), assignments = COALESCE(?, assignments), mean_think_ms = COALESCE(?, mean_think_ms),
        tokens_in = COALESCE(?, tokens_in), tokens_out = COALESCE(?, tokens_out), models = COALESCE(?, models)
       WHERE id = ? AND stroke_count <= ? AND status = 'active'`,
      stats.strokeCount,
      stats.status,
      stats.strokeCount,
      stats.at,
      stats.status,
      stats.at,
      stats.lastScore ?? null,
      stats.assignments ?? null,
      stats.meanThinkMs ?? null,
      stats.tokensIn ?? null,
      stats.tokensOut ?? null,
      stats.models ? JSON.stringify(stats.models) : null,
      id,
      stats.strokeCount,
    );
  }

  /**
   * The gallery: paintings without a reference (runs against one are listed by
   * the reference tests), active ones first, then the most recently painted.
   * Expired paintings are hidden.
   */
  async list(limit: number): Promise<PaintingSummary[]> {
    return this.sql
      .exec<Row>(
        `SELECT ${COLUMNS} FROM paintings WHERE reference IS NULL AND status != 'expired'
         ORDER BY status = 'active' DESC, COALESCE(last_stroke_at, created_at) DESC LIMIT ?`,
        Math.max(1, Math.min(limit, 200)),
      )
      .toArray()
      .map(toSummary);
  }

  async get(id: string): Promise<PaintingSummary | null> {
    return this.row(id);
  }

  /**
   * Runs against a reference (all references, or one): paintings with at least
   * one stroke, oldest first.
   */
  async withReference(reference: string | null, limit: number): Promise<PaintingSummary[]> {
    return this.sql
      .exec<Row>(
        `SELECT ${COLUMNS} FROM paintings
         WHERE status != 'expired' AND stroke_count > 0
           AND reference IS NOT NULL AND (? IS NULL OR reference = ?)
         ORDER BY created_at LIMIT ?`,
        reference,
        reference,
        limit,
      )
      .toArray()
      .map(toSummary);
  }

  /** A series and its paintings, in creation order. */
  async series(id: string): Promise<{ id: string; createdAt: number; paintings: PaintingSummary[] } | null> {
    const series = this.sql
      .exec<{ id: string; created_at: number }>("SELECT id, created_at FROM series WHERE id = ?", id)
      .toArray()[0];
    if (!series) return null;
    const paintings = this.sql
      .exec<Row>(`SELECT ${COLUMNS} FROM paintings WHERE series_id = ? ORDER BY created_at`, id)
      .toArray()
      .map(toSummary);
    return { id: series.id, createdAt: series.created_at, paintings };
  }

  private row(id: string): PaintingSummary | null {
    const row = this.sql.exec<Row>(`SELECT ${COLUMNS} FROM paintings WHERE id = ?`, id).toArray()[0];
    return row ? toSummary(row) : null;
  }
}
