// Built-in reference images (apps/worker/public/references). Paintings may be
// created against one; there are no uploads. A painting made with a reference
// takes the reference's aspect ratio.

import type { StyleName } from "./styles";

export interface ReferenceImage {
  id: string;
  title: string;
  /** Path of the PNG in the static assets. */
  file: string;
  /** Pixel size of that PNG (the canvas aspect ratio follows it). */
  width: number;
  height: number;
  /** The default style for a run against this reference. */
  style: StyleName;
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
    style: "landscape",
    artist: "Raghukamath",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    sourceUrl:
      "https://commons.wikimedia.org/wiki/File:Sunset_-_Landscape_digital_painting_made_in_krita.png",
  },
  {
    id: "mondrian-composition-ii",
    title: "Composition II in Red, Blue, and Yellow (1930)",
    file: "/references/mondrian-composition-ii.png",
    width: 1024,
    height: 1038,
    style: "abstract",
    artist: "Piet Mondrian",
    license: "Public domain",
    licenseUrl: "https://creativecommons.org/publicdomain/mark/1.0/",
    sourceUrl:
      "https://commons.wikimedia.org/wiki/File:Piet_Mondriaan,_1930_-_Mondrian_Composition_II_in_Red,_Blue,_and_Yellow.jpg",
  },
  {
    id: "cappadocia-balloon",
    title: "Inflating a hot-air balloon, Cappadocia",
    file: "/references/cappadocia-balloon.png",
    width: 1024,
    height: 683,
    style: "abstract",
    artist: "Benh LIEU SONG",
    license: "CC BY-SA 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Cappadocia_Balloon_Inflating_Wikimedia_Commons.JPG",
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
