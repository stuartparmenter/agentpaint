// Painting styles: each has a default stroke budget and subjects for pool paintings.

export interface Style {
  name: StyleName;
  maxStrokes: number;
  /** Subjects for new paintings; null means the agents decide. */
  prompts: (string | null)[];
}

export type StyleName = "figurative" | "landscape" | "abstract" | "minimalist";

export const STYLES: Record<StyleName, Style> = {
  figurative: {
    name: "figurative",
    maxStrokes: 800,
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
    prompts: [null],
  },
  minimalist: {
    name: "minimalist",
    maxStrokes: 60,
    prompts: [null],
  },
};

export const STYLE_NAMES = Object.keys(STYLES) as StyleName[];

export function pick<T>(items: readonly T[]): T {
  const [random = 0] = crypto.getRandomValues(new Uint32Array(1));
  const index = random % items.length;
  return items[index] as T;
}
