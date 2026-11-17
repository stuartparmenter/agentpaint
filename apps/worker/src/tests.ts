// Reference tests: every created painting made against a built-in reference,
// grouped into conditions whose runs can be compared with each other.

import type { ReferenceImage } from "./references";
import type { SeriesCell } from "./series";
import type { PaintingSummary } from "./types";

/** Settings that must match for two runs' scores to be comparable. */
export interface Condition {
  key: string;
  style: string;
  size: string | null;
  width: number;
  height: number;
  maxStrokes: number;
  phases: string;
  runs: number;
}

/** One reference on the tests index. */
export interface TestSummary {
  reference: ReferenceImage;
  runs: number;
  finished: number;
  models: string[];
  /** The finished run closest to the reference, with its blank-canvas score for scale. */
  best: { score: number; blankScore: number } | null;
  lastRunAt: number | null;
}

/** One reference's test, narrowed to a condition (and optionally a series). */
export interface TestDetail {
  reference: ReferenceImage;
  conditions: Condition[];
  /** Key of the condition shown; null when the reference has no runs. */
  condition: string | null;
  series: string | null;
  anchors: { blank: number | null; meanColor: number | null };
  paintings: PaintingSummary[];
  /** Score after each stroke, per painting id, downsampled: [stroke, score] pairs. */
  curves: Record<string, [number, number][]>;
  table: SeriesCell[];
}

export function conditionKey(p: PaintingSummary): string {
  return `${p.style}-${p.size ?? "custom"}-${p.width}x${p.height}-${p.maxStrokes}-${p.phases}`;
}

const isFinished = (p: PaintingSummary) => p.status === "done" || p.status === "archived";

/** Conditions present among `paintings`, most runs first. */
export function conditions(paintings: PaintingSummary[]): Condition[] {
  const byKey = new Map<string, Condition>();
  for (const p of paintings) {
    const key = conditionKey(p);
    const c = byKey.get(key);
    if (c) c.runs++;
    else
      byKey.set(key, {
        key,
        style: p.style,
        size: p.size,
        width: p.width,
        height: p.height,
        maxStrokes: p.maxStrokes,
        phases: p.phases,
        runs: 1,
      });
  }
  return [...byKey.values()].sort((a, b) => b.runs - a.runs || a.key.localeCompare(b.key));
}

/** The tests index: one entry per built-in reference, including ones with no runs yet. */
export function testsIndex(
  references: readonly ReferenceImage[],
  paintings: PaintingSummary[],
): TestSummary[] {
  return references.map((reference) => {
    const runs = paintings.filter((p) => p.reference === reference.id);
    // Canvas sizes differ in blank score, so runs are compared by how far they rose above it.
    const scored = runs.flatMap((p) =>
      isFinished(p) && p.lastScore !== null && p.blankScore !== null
        ? [{ score: p.lastScore, blankScore: p.blankScore }]
        : [],
    );
    const rise = (r: { score: number; blankScore: number }) => (r.score - r.blankScore) / (1 - r.blankScore);
    return {
      reference,
      runs: runs.length,
      finished: runs.filter(isFinished).length,
      models: [...new Set(runs.flatMap((p) => p.models))].sort(),
      best: scored.reduce<(typeof scored)[number] | null>((a, r) => (a && rise(a) >= rise(r) ? a : r), null),
      lastRunAt: runs.length ? Math.max(...runs.map((p) => p.lastStrokeAt ?? p.createdAt)) : null,
    };
  });
}

/**
 * Pick the condition to show: the requested one if it exists, else the one with
 * the most runs. With a series, only that series' paintings count.
 */
export function selectRuns(
  paintings: PaintingSummary[],
  requested: { condition?: string | null; series?: string | null },
): { conditions: Condition[]; condition: string | null; paintings: PaintingSummary[] } {
  const pool = requested.series ? paintings.filter((p) => p.seriesId === requested.series) : paintings;
  const all = conditions(pool);
  const chosen = all.find((c) => c.key === requested.condition)?.key ?? all[0]?.key ?? null;
  return {
    conditions: all,
    condition: chosen,
    paintings: pool.filter((p) => conditionKey(p) === chosen),
  };
}

/** Keep at most `max` points, always including the first and last. */
export function downsample<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)] as T);
}
