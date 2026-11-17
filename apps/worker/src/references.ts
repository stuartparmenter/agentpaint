// Built-in reference images (apps/worker/public/references). Paintings may be
// created against one; there are no uploads. A painting made with a reference
// takes the reference's aspect ratio.

export interface ReferenceImage {
  id: string;
  title: string;
  /** Path of the PNG in the static assets. */
  file: string;
  /** Pixel size of that PNG (the canvas aspect ratio follows it). */
  width: number;
  height: number;
  artist: string;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
}

export const REFERENCES: readonly ReferenceImage[] = [
  {
    id: "krita-sunset",
    title: "Sunset, landscape digital painting made in Krita",
    file: "/references/krita-sunset.png",
    width: 1024,
    height: 576,
    artist: "Raghukamath",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    sourceUrl:
      "https://commons.wikimedia.org/wiki/File:Sunset_-_Landscape_digital_painting_made_in_krita.png",
  },
];

export function findReference(id: string): ReferenceImage | undefined {
  return REFERENCES.find((r) => r.id === id);
}

/** Canvas size for a painting `width` wide: square, or the reference's aspect ratio. */
export function canvasSize(
  width: number,
  reference: ReferenceImage | undefined,
): { width: number; height: number } {
  return { width, height: reference ? Math.round((width * reference.height) / reference.width) : width };
}
