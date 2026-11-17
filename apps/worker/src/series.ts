import type { PaintingSummary } from "./types";

export const NOT_REPORTED = "(not reported)";

/** Whether a created painting is finished (created paintings are never archived). */
export function isFinished(p: PaintingSummary): boolean {
  return p.status === "done";
}

export interface SeriesCell {
  /** Self-reported models, joined; "(not reported)" when the painter reports none. */
  models: string;
  strokes_per_assignment: number;
  paintings: number;
  /** Ids of the cell's paintings, in the order given. */
  painting_ids: string[];
  finished: number;
  final_score: number | null;
  strokes_used: number;
  assignments: number;
  mean_think_ms: number | null;
  tokens_in: number;
  tokens_out: number;
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** Group a series' paintings into cells (models x strokes per assignment), averaging repeats. */
export function seriesTable(paintings: PaintingSummary[]): SeriesCell[] {
  const cells = new Map<string, PaintingSummary[]>();
  for (const p of paintings) {
    const models = p.models.length ? p.models.join(" + ") : NOT_REPORTED;
    const key = `${models}\u0000${p.strokesPerAssignment}`;
    cells.set(key, [...(cells.get(key) ?? []), p]);
  }
  return [...cells.entries()]
    .map(([key, ps]) => {
      const scores = ps.flatMap((p) => (p.lastScore === null ? [] : [p.lastScore]));
      const thinks = ps.flatMap((p) => (p.meanThinkMs === null ? [] : [p.meanThinkMs]));
      return {
        models: key.split("\u0000")[0] as string,
        strokes_per_assignment: ps[0]?.strokesPerAssignment ?? 1,
        paintings: ps.length,
        painting_ids: ps.map((p) => p.id),
        finished: ps.filter(isFinished).length,
        final_score: mean(scores),
        strokes_used: mean(ps.map((p) => p.strokeCount)) ?? 0,
        assignments: mean(ps.map((p) => p.assignments)) ?? 0,
        mean_think_ms: mean(thinks),
        tokens_in: mean(ps.map((p) => p.tokensIn)) ?? 0,
        tokens_out: mean(ps.map((p) => p.tokensOut)) ?? 0,
      };
    })
    .sort((a, b) => a.models.localeCompare(b.models) || a.strokes_per_assignment - b.strokes_per_assignment);
}
