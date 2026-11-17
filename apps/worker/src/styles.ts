// Painting styles: stroke budgets and phases with mechanical constraints.
// Phases only set brush-size floors and give brief orientation; creative
// decisions (color, placement, composition, interpretation) stay with the agent.

export interface Phase {
  name: string;
  /** Progress ratio (stroke_count / max_strokes) at which this phase ends. */
  until: number;
  /** Minimum brush diameter in canvas pixels, enforced on submit. */
  minBrushSize: number;
  guidance: string;
}

export interface Style {
  name: StyleName;
  maxStrokes: number;
  phases: Phase[];
  /** Subjects for new paintings; null means the agents decide. */
  prompts: (string | null)[];
}

export type StyleName = "figurative" | "landscape" | "abstract" | "minimalist";

export const STYLES: Record<StyleName, Style> = {
  figurative: {
    name: "figurative",
    maxStrokes: 800,
    phases: [
      {
        name: "foundation",
        until: 0.1,
        minBrushSize: 120,
        guidance:
          "Cover the canvas. Lay in the major value masses: large areas of dark and light. No detail, no outlines.",
      },
      {
        name: "structure",
        until: 0.35,
        minBrushSize: 50,
        guidance: "Build major shapes. Separate the subject from the background. Establish the big forms.",
      },
      {
        name: "modeling",
        until: 0.75,
        minBrushSize: 15,
        guidance:
          "Model form with color and value. Add light/shadow transitions, secondary shapes, color variation.",
      },
      {
        name: "detail",
        until: 1,
        minBrushSize: 1,
        guidance: "Accents and finishing touches. Sharpen edges at focal points. Highlights, small details.",
      },
    ],
    prompts: [
      "a portrait of an old fisherman",
      "a cat asleep on a windowsill",
      "a dancer mid-turn",
      "a still life of fruit and a jug",
      "a musician playing in the street",
      null,
    ],
  },
  landscape: {
    name: "landscape",
    maxStrokes: 1000,
    phases: [
      {
        name: "foundation",
        until: 0.12,
        minBrushSize: 120,
        guidance: "Cover the canvas. Block in sky, ground, and major masses with broad strokes.",
      },
      {
        name: "structure",
        until: 0.4,
        minBrushSize: 50,
        guidance:
          "Build depth and atmosphere. Separate foreground, middle ground, background. Push distant areas cooler and lighter.",
      },
      {
        name: "features",
        until: 0.8,
        minBrushSize: 15,
        guidance:
          "Define landscape features: trees, rocks, water, buildings. Add color variation and texture.",
      },
      {
        name: "detail",
        until: 1,
        minBrushSize: 1,
        guidance: "Light effects, highlights, reflections, fine texture. Focus on the focal point.",
      },
    ],
    prompts: [
      "a harbor at dawn",
      "mountains after a storm",
      "a field of sunflowers at noon",
      "a quiet city street in the rain",
      "a forest path in autumn",
      null,
    ],
  },
  abstract: {
    name: "abstract",
    maxStrokes: 400,
    phases: [
      {
        name: "energy",
        until: 0.2,
        minBrushSize: 80,
        guidance: "Establish the energy. Bold, committed marks. Fill the canvas with broad strokes.",
      },
      {
        name: "rhythm",
        until: 0.65,
        minBrushSize: 20,
        guidance: "Build rhythm and contrast. Vary direction and pressure. Respond to what's on the canvas.",
      },
      {
        name: "resolution",
        until: 1,
        minBrushSize: 1,
        guidance: "Balance and resolve. Add tension or calm where needed. Punctuate with accents.",
      },
    ],
    prompts: [null],
  },
  minimalist: {
    name: "minimalist",
    maxStrokes: 60,
    phases: [
      {
        name: "composition",
        until: 0.5,
        minBrushSize: 40,
        guidance:
          "Each stroke is a major compositional element. Negative space is intentional. Make every mark count.",
      },
      {
        name: "refinement",
        until: 1,
        minBrushSize: 1,
        guidance:
          "Small adjustments only. Consider whether the painting needs this stroke at all. Less is more.",
      },
    ],
    prompts: [null],
  },
};

export const STYLE_NAMES = Object.keys(STYLES) as StyleName[];

export function isStyleName(name: string): name is StyleName {
  return Object.hasOwn(STYLES, name);
}

/** The phase at `strokeCount` strokes into a budget of `maxStrokes` (the style's own by default). */
export function currentPhase(style: Style, strokeCount: number, maxStrokes = style.maxStrokes): Phase {
  const progress = strokeCount / maxStrokes;
  return style.phases.find((p) => progress < p.until) ?? (style.phases.at(-1) as Phase);
}

export function pick<T>(items: readonly T[]): T {
  const [random = 0] = crypto.getRandomValues(new Uint32Array(1));
  const index = random % items.length;
  return items[index] as T;
}
