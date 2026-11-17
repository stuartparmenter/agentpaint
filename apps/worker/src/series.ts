import type { PaintingSummary } from "./types";

export interface SeriesCell {
  /** Self-reported models, joined; "(none reported)" for random or unlabeled painters. */
  models: string;
  strokes_per_look: number;
  paintings: number;
  finished: number;
  final_score: number | null;
  strokes_used: number;
  looks: number;
  mean_think_ms: number | null;
  tokens_in: number;
  tokens_out: number;
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** Group a series' paintings into cells (models x strokes per look), averaging repeats. */
export function seriesTable(paintings: PaintingSummary[]): SeriesCell[] {
  const cells = new Map<string, PaintingSummary[]>();
  for (const p of paintings) {
    const models = p.models.length ? p.models.join(" + ") : "(none reported)";
    const key = `${models}\u0000${p.strokesPerLook}`;
    cells.set(key, [...(cells.get(key) ?? []), p]);
  }
  return [...cells.entries()]
    .map(([key, ps]) => {
      const scores = ps.flatMap((p) => (p.lastScore === null ? [] : [p.lastScore]));
      const thinks = ps.flatMap((p) => (p.meanThinkMs === null ? [] : [p.meanThinkMs]));
      return {
        models: key.split("\u0000")[0] as string,
        strokes_per_look: ps[0]?.strokesPerLook ?? 1,
        paintings: ps.length,
        finished: ps.filter((p) => p.status === "done" || p.status === "archived").length,
        final_score: mean(scores),
        strokes_used: mean(ps.map((p) => p.strokeCount)) ?? 0,
        looks: mean(ps.map((p) => p.looks)) ?? 0,
        mean_think_ms: mean(thinks),
        tokens_in: mean(ps.map((p) => p.tokensIn)) ?? 0,
        tokens_out: mean(ps.map((p) => p.tokensOut)) ?? 0,
      };
    })
    .sort((a, b) => a.models.localeCompare(b.models) || a.strokes_per_look - b.strokes_per_look);
}
