import {
  DEFAULT_MAX_CREATED_PAINTINGS,
  DEFAULT_MAX_CREATED_PER_CLIENT,
  envNumber,
  SIZES,
  SNAPSHOT_QUALITY,
} from "./config";
import { KEY_LENGTH, randomId, sha256Hex } from "./ids";
import { canvasSize, findReference } from "./references";
import { prepareReference } from "./renderer";
import { type CreateInput, studyBudget } from "./settings";
import { STYLES } from "./styles";
import type { CreateSettings, PaintingSummary } from "./types";

export interface Created {
  id: string;
  agent_key: string;
  owner_key: string;
  mcp_url: string;
  painting_url: string;
  series_id: string;
  /** Only when this painting started a new series; needed to add siblings. */
  series_key: string | null;
  settings: PaintingSummary;
}

export type CreateError = { status: 400 | 403 | 404 | 409 | 429 | 500; error: string };

interface PreparedReference {
  jpeg: Uint8Array;
  grid: Float32Array;
  blankScore: number;
  meanColorScore: number;
}

// Preparing a reference is deterministic, so cache it per isolate.
const prepared = new Map<string, Promise<PreparedReference>>();

function prepare(env: Env, origin: string, file: string, width: number, height: number) {
  const key = `${file}:${width}x${height}`;
  let entry = prepared.get(key);
  if (!entry) {
    entry = (async () => {
      const res = await env.ASSETS.fetch(new Request(new URL(file, origin)));
      if (!res.ok) throw new Error(`reference asset ${file} returned ${res.status}`);
      const reference = prepareReference(
        new Uint8Array(await res.arrayBuffer()),
        width,
        height,
        SNAPSHOT_QUALITY,
      );
      try {
        return {
          jpeg: reference.jpeg,
          grid: reference.grid,
          blankScore: reference.blankScore,
          meanColorScore: reference.meanColorScore,
        };
      } finally {
        reference.free();
      }
    })();
    entry.catch(() => prepared.delete(key));
    prepared.set(key, entry);
  }
  return entry;
}

/**
 * Create a painting from validated input. `origin` is the site origin, for URLs;
 * `client` is the caller's address, for the per-client cap.
 */
export async function createPainting(
  env: Env,
  input: CreateInput,
  origin: string,
  client: string,
): Promise<Created | CreateError> {
  const style = STYLES[input.style];
  const reference = input.reference ? findReference(input.reference) : undefined;
  if (input.reference && !reference) return { status: 400, error: `unknown reference '${input.reference}'` };
  if (input.series && !input.series_key)
    return { status: 400, error: "series_key is required to add to a series" };

  const size = input.size;
  const { width, height } = canvasSize(SIZES[size], reference);
  const maxStrokes =
    input.max_strokes ?? (size === "study" ? studyBudget(style.maxStrokes) : style.maxStrokes);

  if (input.strokes_per_look > maxStrokes) {
    return { status: 400, error: `strokes_per_look must be at most max_strokes (${maxStrokes})` };
  }

  let ref: PreparedReference | null = null;
  if (reference) {
    try {
      ref = await prepare(env, origin, reference.file, width, height);
    } catch (e) {
      console.error("reference preparation failed", reference.id, e);
      return { status: 500, error: "could not prepare the reference image" };
    }
  }

  const settings: CreateSettings = {
    style: style.name,
    prompt: input.prompt ?? null,
    size,
    width,
    height,
    maxStrokes,
    strokesPerLook: input.strokes_per_look,
    phases: input.phases,
    reference: reference?.id ?? null,
    blankScore: ref?.blankScore ?? null,
    meanColorScore: ref?.meanColorScore ?? null,
  };
  const agentKey = randomId(KEY_LENGTH);
  const ownerKey = randomId(KEY_LENGTH);
  const seriesKey = randomId(KEY_LENGTH);
  const series =
    input.series && input.series_key
      ? { id: input.series, keyHash: await sha256Hex(input.series_key) }
      : null;

  const registry = env.REGISTRY.getByName("registry");
  const result = await registry.createPainting(
    settings,
    series,
    { key: seriesKey, keyHash: await sha256Hex(seriesKey) },
    client,
    {
      total: envNumber(env.MAX_CREATED_PAINTINGS, DEFAULT_MAX_CREATED_PAINTINGS),
      perClient: envNumber(env.MAX_CREATED_PER_CLIENT, DEFAULT_MAX_CREATED_PER_CLIENT),
    },
  );
  if (!result.ok) {
    const status = {
      series_not_found: 404,
      series_key_mismatch: 403,
      too_many_paintings: 409,
      too_many_paintings_for_client: 429,
    }[result.error] as CreateError["status"];
    return { status, error: result.error };
  }

  const painting = result.painting;
  try {
    await env.PAINTING.getByName(painting.id).init(painting, {
      agentKeyHash: await sha256Hex(agentKey),
      ownerKeyHash: await sha256Hex(ownerKey),
      referenceGrid: ref?.grid ?? null,
      referenceJpeg: ref?.jpeg ?? null,
    });
  } catch (e) {
    console.error("painting init failed", painting.id, e);
    await registry.recordStroke(painting.id, { strokeCount: 0, status: "expired", at: Date.now() });
    return { status: 500, error: "could not create the painting" };
  }

  return {
    id: painting.id,
    agent_key: agentKey,
    owner_key: ownerKey,
    mcp_url: `${origin}/mcp/p/${painting.id}/${agentKey}`,
    painting_url: `${origin}/p/${painting.id}`,
    series_id: result.seriesId,
    series_key: result.seriesKey,
    settings: painting,
  };
}
