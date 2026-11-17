import { DurableObject } from "cloudflare:workers";
import { ARCHIVE_AFTER_MS, CANVAS_SIZE, LEASE_MS, MEDIUM } from "./config";
import { PAINTING_ID_LENGTH, randomId } from "./ids";
import { pick, STYLE_NAMES, STYLES, type StyleName } from "./styles";

export type PaintingStatus = "active" | "done" | "archived";

export interface PaintingSummary {
  id: string;
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
}

interface Row extends Record<string, SqlStorageValue> {
  id: string;
  status: string;
  style: string;
  prompt: string | null;
  medium: string;
  width: number;
  height: number;
  stroke_count: number;
  max_strokes: number;
  created_at: number;
  last_stroke_at: number | null;
  finished_at: number | null;
  lease_until: number;
}

function toSummary(r: Row): PaintingSummary {
  return {
    id: r.id,
    status: r.status as PaintingStatus,
    style: r.style as StyleName,
    prompt: r.prompt,
    medium: r.medium,
    width: r.width,
    height: r.height,
    strokeCount: r.stroke_count,
    maxStrokes: r.max_strokes,
    createdAt: r.created_at,
    lastStrokeAt: r.last_stroke_at,
    finishedAt: r.finished_at,
  };
}

/**
 * The global index of paintings (a single instance, named "registry").
 * Hands out leases so concurrent agents work on different paintings.
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
      medium TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      stroke_count INTEGER NOT NULL DEFAULT 0,
      max_strokes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_stroke_at INTEGER,
      finished_at INTEGER,
      lease_until INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS paintings_status ON paintings (status, last_stroke_at)");
  }

  /**
   * Reserve an active painting that nobody holds, preferring the one painted
   * least recently. Creates a painting when none is free and fewer than
   * `maxActive` are in progress; otherwise shares a reserved one. Returns null
   * only when no painting can be offered at all.
   */
  async lease(maxActive: number): Promise<{ painting: PaintingSummary; created: boolean } | null> {
    const now = Date.now();
    this.archiveFinished(now);
    const free = this.sql
      .exec<Row>(
        `SELECT * FROM paintings WHERE status = 'active' AND lease_until <= ?
         ORDER BY last_stroke_at IS NOT NULL, last_stroke_at, created_at LIMIT 1`,
        now,
      )
      .toArray()[0];
    if (free) {
      this.sql.exec("UPDATE paintings SET lease_until = ? WHERE id = ?", now + LEASE_MS, free.id);
      return { painting: toSummary(free), created: false };
    }

    const active = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM paintings WHERE status = 'active'")
      .one().n;
    if (active >= maxActive) {
      // Everything is reserved and no new painting may start. Rather than leave
      // the agent idle, share the painting whose reservation ends soonest: whoever
      // submits first wins, and the other gets stale_assignment (v1's behavior).
      const shared = this.sql
        .exec<Row>("SELECT * FROM paintings WHERE status = 'active' ORDER BY lease_until LIMIT 1")
        .toArray()[0];
      return shared ? { painting: toSummary(shared), created: false } : null;
    }

    const style = STYLES[pick(STYLE_NAMES)];
    const row: Row = {
      id: randomId(PAINTING_ID_LENGTH),
      status: "active",
      style: style.name,
      prompt: pick(style.prompts),
      medium: MEDIUM,
      width: CANVAS_SIZE,
      height: CANVAS_SIZE,
      stroke_count: 0,
      max_strokes: style.maxStrokes,
      created_at: now,
      last_stroke_at: null,
      finished_at: null,
      lease_until: now + LEASE_MS,
    };
    this.sql.exec(
      `INSERT INTO paintings (id, status, style, prompt, medium, width, height, stroke_count, max_strokes,
        created_at, last_stroke_at, finished_at, lease_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...Object.values(row),
    );
    return { painting: toSummary(row), created: true };
  }

  /** Give a lease back early (e.g. the assignment could not be created). */
  async release(id: string): Promise<void> {
    this.sql.exec("UPDATE paintings SET lease_until = 0 WHERE id = ?", id);
  }

  /** Called by the painting after each applied stroke; also ends the lease. */
  async recordStroke(id: string, strokeCount: number, status: PaintingStatus, at: number): Promise<void> {
    // Updates can arrive out of order (each is sent after the stroke's R2
    // writes); never let an older one roll the painting back.
    this.sql.exec(
      `UPDATE paintings SET stroke_count = ?, status = ?, last_stroke_at = ?, lease_until = 0,
        finished_at = CASE WHEN ? = 'done' AND finished_at IS NULL THEN ? ELSE finished_at END
       WHERE id = ? AND stroke_count <= ? AND status = 'active'`,
      strokeCount,
      status,
      at,
      status,
      at,
      id,
      strokeCount,
    );
    this.archiveFinished(Date.now());
  }

  // Reads are side-effect free (they're on the public, anonymous path); a done
  // painting past its grace period reads as archived even before the
  // archiving UPDATE runs on the next lease or stroke.
  async list(limit: number): Promise<PaintingSummary[]> {
    return this.sql
      .exec<Row>(
        `SELECT ${this.columns()} FROM paintings
         ORDER BY status = 'active' DESC, COALESCE(last_stroke_at, created_at) DESC LIMIT ?`,
        Date.now() - ARCHIVE_AFTER_MS,
        Math.max(1, Math.min(limit, 200)),
      )
      .toArray()
      .map(toSummary);
  }

  async get(id: string): Promise<PaintingSummary | null> {
    const row = this.sql
      .exec<Row>(`SELECT ${this.columns()} FROM paintings WHERE id = ?`, Date.now() - ARCHIVE_AFTER_MS, id)
      .toArray()[0];
    return row ? toSummary(row) : null;
  }

  /** Columns with `status` computed as of now; takes the archive cutoff as its parameter. */
  private columns() {
    return `id, CASE WHEN status = 'done' AND finished_at <= ? THEN 'archived' ELSE status END AS status,
      style, prompt, medium, width, height, stroke_count, max_strokes, created_at, last_stroke_at,
      finished_at, lease_until`;
  }

  private archiveFinished(now: number) {
    this.sql.exec(
      "UPDATE paintings SET status = 'archived' WHERE status = 'done' AND finished_at <= ?",
      now - ARCHIVE_AFTER_MS,
    );
  }
}
