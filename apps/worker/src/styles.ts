// Painting styles: each has a default stroke budget.

export interface Style {
  name: StyleName;
  maxStrokes: number;
}

export type StyleName = "figurative" | "landscape" | "abstract" | "minimalist";

export const STYLES: Record<StyleName, Style> = {
  figurative: { name: "figurative", maxStrokes: 800 },
  landscape: { name: "landscape", maxStrokes: 1000 },
  abstract: { name: "abstract", maxStrokes: 400 },
  minimalist: { name: "minimalist", maxStrokes: 60 },
};

export const STYLE_NAMES = Object.keys(STYLES) as StyleName[];
