import * as z from "zod/v4";
import { NOTE_MAX } from "./config";

// The stroke agents submit, in canvas pixels. The renderer works in
// normalized units (fractions of the canvas), so strokes replay at any size.

export const MAX_POINTS = 50;
export const MAX_BRUSH_SIZE = 200;

const unit = z.number().min(0).max(1);

export const strokeInput = z.object({
  points: z
    .array(
      z.object({
        x: z.number().describe("Canvas x in pixels, 0 to canvas_width"),
        y: z.number().describe("Canvas y in pixels, 0 to canvas_height"),
        pressure: unit.describe("Pen pressure 0-1: scales width slightly and gates paint (none below 0.1)"),
      }),
    )
    .min(2)
    .max(MAX_POINTS)
    .describe("Control points along the stroke (2-50); the path is smoothed through them"),
  brush: z.object({
    size: z
      .number()
      .min(1)
      .max(MAX_BRUSH_SIZE)
      .describe("Brush diameter in pixels; must be at least the phase's min_brush_size"),
    hardness: unit.describe("Edge hardness: 0 = soft and feathered, 1 = crisp"),
    opacity: unit.describe("Maximum opacity this stroke can reach"),
    flow: unit.describe("Paint deposited per pass; builds up toward opacity"),
  }),
  color: z.object({
    r: z.number().int().min(0).max(255),
    g: z.number().int().min(0).max(255),
    b: z.number().int().min(0).max(255),
  }),
  speed: z
    .number()
    .min(10)
    .max(5000)
    .optional()
    .describe("Drawing speed in pixels/second (100-200 careful, 300-500 normal, 600-1000 sweeping)"),
});

export type StrokeInput = z.infer<typeof strokeInput>;

/** One stroke of a batch on a created painting, with the painter's optional note. */
export const batchStrokeInput = strokeInput.extend({
  note: z.string().max(NOTE_MAX).optional().describe("One line on what this stroke is for (optional)"),
});

export type BatchStrokeInput = z.infer<typeof batchStrokeInput>;

/** Largest brush diameter on a canvas this wide (MAX_BRUSH_SIZE at 1024 px, scaled). */
export function maxBrushSize(width: number): number {
  return Math.round((MAX_BRUSH_SIZE * width) / 1024);
}

/** A phase's minimum brush diameter (defined at 1024 px) scaled to this canvas. */
export function scaledMinBrush(minBrushSize: number, width: number): number {
  return Math.max(1, Math.round((minBrushSize * width) / 1024));
}

/** Renderer stroke format (see crates/renderer/src/stroke.rs). */
export interface NormalizedStroke {
  points: { x: number; y: number; pressure: number }[];
  brush: { size: number; hardness: number; opacity: number; flow: number };
  color: { r: number; g: number; b: number };
  speed: number | null;
}

/** Range checks that depend on the canvas; returns an error message or null. */
export function checkBounds(stroke: StrokeInput, width: number, height: number): string | null {
  if (stroke.brush.size > maxBrushSize(width)) {
    return `brush.size must be at most ${maxBrushSize(width)} on a ${width}x${height} canvas`;
  }
  for (const [i, p] of stroke.points.entries()) {
    if (p.x < 0 || p.x > width || p.y < 0 || p.y > height) {
      return `points[${i}] is outside the ${width}x${height} canvas`;
    }
  }
  return null;
}

export function normalize(stroke: StrokeInput, width: number, height: number): NormalizedStroke {
  return {
    points: stroke.points.map((p) => ({ x: p.x / width, y: p.y / height, pressure: p.pressure })),
    brush: {
      size: stroke.brush.size / width,
      hardness: stroke.brush.hardness,
      opacity: stroke.brush.opacity,
      flow: stroke.brush.flow,
    },
    color: stroke.color,
    speed: stroke.speed ?? null,
  };
}
