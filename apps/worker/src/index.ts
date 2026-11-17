import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authenticate } from "./auth";
import { createPainting } from "./create";
import { KEY, PAINTING_ID, SERIES_ID } from "./ids";
import { handleMcp, handleScopedMcp } from "./mcp";
import { referenceKey, snapshotKey } from "./painting";
import { findReference, REFERENCES } from "./references";
import { mixingModel, rendererVersion } from "./renderer";
import { seriesTable } from "./series";
import { createInput, studyBudget } from "./settings";
import { STYLE_NAMES, STYLES } from "./styles";
import { downsample, selectRuns, type TestDetail, testsIndex } from "./tests";

export { Painting } from "./painting";
export { Registry } from "./registry";

type AppContext = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();

app.use(async (c, next) => {
  await next();
  // Some responses (e.g. from the Cache API) have immutable headers; copy before editing.
  c.res = new Response(c.res.body, c.res);
  c.res.headers.set("X-Content-Type-Options", "nosniff");
});

/**
 * Serve a public GET from the edge cache when possible, so anonymous gallery
 * traffic doesn't all land on the singleton Registry or on R2.
 */
async function cached(
  c: AppContext,
  ttlSeconds: number,
  produce: () => Promise<Response>,
  params: string[] = [],
) {
  // Key on the path and the query parameters the endpoint reads, so other query
  // strings can't be used to skip the cache.
  const url = new URL(c.req.url);
  const key = new URL(url.pathname, url.origin);
  for (const name of params) {
    const value = url.searchParams.get(name);
    if (value !== null) key.searchParams.set(name, value);
  }
  const cache = caches.default;
  const hit = await cache.match(key);
  // Cached responses have immutable headers; hand back a mutable copy.
  if (hit) return new Response(hit.body, hit);
  const response = await produce();
  if (response.ok) {
    const copy = new Response(response.body, response);
    copy.headers.set(
      "Cache-Control",
      ttlSeconds >= 3600 ? `public, max-age=${ttlSeconds}, immutable` : `public, max-age=${ttlSeconds}`,
    );
    c.executionCtx.waitUntil(cache.put(key, copy.clone()));
    return copy;
  }
  return response;
}

/** Parse a JSON-RPC body, rejecting batches (they would multiply the rate limit). */
async function rpcBody(c: AppContext): Promise<{ body: unknown } | Response> {
  if (c.req.method !== "POST") return { body: undefined };
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  if (Array.isArray(body)) {
    return c.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch requests are not supported" } },
      400,
    );
  }
  return { body };
}

const bearer = (header: string | undefined) => /^Bearer (\S{1,256})$/.exec(header ?? "")?.[1];
const tooLarge = bodyLimit({
  maxSize: 64 * 1024,
  onError: (c) => c.json({ error: "request body too large" }, 413),
});

app.get("/api/health", (c) => c.json({ ok: true, renderer: rendererVersion(), mixing: mixingModel() }));

app.get("/api/styles", (c) =>
  c.json(
    STYLE_NAMES.map((name) => ({
      name,
      max_strokes: { full: STYLES[name].maxStrokes, study: studyBudget(STYLES[name].maxStrokes) },
      phases: STYLES[name].phases.map((p) => ({
        name: p.name,
        until: p.until,
        min_brush_size: p.minBrushSize,
      })),
    })),
  ),
);

app.get("/api/references", (c) =>
  c.json(
    REFERENCES.map((r) => ({
      id: r.id,
      title: r.title,
      url: r.file,
      width: r.width,
      height: r.height,
      artist: r.artist,
      license: r.license,
      license_url: r.licenseUrl,
      source_url: r.sourceUrl,
    })),
  ),
);

app.get("/api/paintings", (c) =>
  cached(c, 4, async () => c.json(await c.env.REGISTRY.getByName("registry").list(100))),
);

// Create a painting. Public, rate-limited per client IP. The response holds the
// painting's keys, so it is never cached.
app.post("/api/paintings", tooLarge, async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "local";
  const { success } = await c.env.CREATE_LIMITER.limit({ key: `create:${ip}` });
  if (!success) return c.json({ error: "rate limited" }, 429, { "Retry-After": "60" });
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }
  const input = createInput.safeParse(raw);
  if (!input.success) {
    return c.json(
      {
        error: "invalid settings",
        issues: input.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
      400,
    );
  }
  const result = await createPainting(c.env, input.data, new URL(c.req.url).origin, ip);
  if ("error" in result) return c.json({ error: result.error }, result.status);
  return c.json(result, 201, { "Cache-Control": "no-store" });
});

app.get("/api/paintings/:id", async (c) => {
  const id = c.req.param("id");
  if (!PAINTING_ID.test(id)) return c.notFound();
  return cached(c, 4, async () => {
    const painting = await c.env.REGISTRY.getByName("registry").get(id);
    return painting ? c.json(painting) : c.notFound();
  });
});

app.get("/api/paintings/:id/strokes", async (c) => {
  const id = c.req.param("id");
  if (!PAINTING_ID.test(id)) return c.notFound();
  return cached(c, 4, async () => {
    const log = await c.env.PAINTING.getByName(id).strokeLog();
    return log ? c.json(log) : c.notFound();
  });
});

app.post("/api/paintings/:id/finish", async (c) => {
  const id = c.req.param("id");
  const key = bearer(c.req.header("Authorization"));
  if (!PAINTING_ID.test(id) || !key || !KEY.test(key)) return c.json({ error: "unauthorized" }, 401);
  const ok = await c.env.PAINTING.getByName(id).finishByOwner(key);
  return ok
    ? c.json({ finished: true }, 200, { "Cache-Control": "no-store" })
    : c.json({ error: "unauthorized" }, 401);
});

// Owner-only check that the stroke log replays to the stored snapshot.
app.post("/api/paintings/:id/verify", async (c) => {
  const id = c.req.param("id");
  const key = bearer(c.req.header("Authorization"));
  if (!PAINTING_ID.test(id) || !key || !KEY.test(key)) return c.json({ error: "unauthorized" }, 401);
  const result = await c.env.PAINTING.getByName(id).verifyReplay(key);
  return result
    ? c.json(result, 200, { "Cache-Control": "no-store" })
    : c.json({ error: "unauthorized" }, 401);
});

app.get("/api/paintings/:id/reference", async (c) => {
  const id = c.req.param("id");
  if (!PAINTING_ID.test(id)) return c.notFound();
  return cached(c, 31536000, async () => {
    const object = await c.env.SNAPSHOTS.get(referenceKey(id));
    if (!object) return c.notFound();
    return new Response(object.body, { headers: { "Content-Type": "image/jpeg", ETag: object.httpEtag } });
  });
});

app.get("/api/paintings/:id/v/:version", async (c) => {
  const { id, version } = c.req.param();
  if (!PAINTING_ID.test(id) || !/^(0|[1-9]\d{0,5})$/.test(version)) return c.notFound();
  // A version's snapshot never changes.
  return cached(c, 31536000, async () => {
    const object = await c.env.SNAPSHOTS.get(snapshotKey(id, Number(version)));
    if (!object) return c.notFound();
    return new Response(object.body, { headers: { "Content-Type": "image/jpeg", ETag: object.httpEtag } });
  });
});

app.get("/api/series/:id", async (c) => {
  const id = c.req.param("id");
  if (!SERIES_ID.test(id)) return c.notFound();
  return cached(c, 4, async () => {
    const series = await c.env.REGISTRY.getByName("registry").series(id);
    if (!series) return c.notFound();
    return c.json({ ...series, table: seriesTable(series.paintings) });
  });
});

// Reference tests: each built-in reference with the runs made against it.
const MAX_TEST_RUNS = 300;
const CURVE_POINTS = 200;

app.get("/api/tests", (c) =>
  cached(c, 10, async () => {
    const runs = await c.env.REGISTRY.getByName("registry").withReference(null, 5000);
    return c.json(testsIndex(REFERENCES, runs));
  }),
);

app.get("/api/tests/:reference", (c) => {
  const reference = findReference(c.req.param("reference"));
  if (!reference) return c.notFound();
  const series = c.req.query("series") ?? null;
  if (series !== null && !SERIES_ID.test(series)) return c.json({ error: "bad series id" }, 400);
  return cached(
    c,
    10,
    async () => {
      const runs = await c.env.REGISTRY.getByName("registry").withReference(reference.id, MAX_TEST_RUNS);
      const selected = selectRuns(runs, { condition: c.req.query("condition"), series });
      const curves = Object.fromEntries(
        await Promise.all(
          selected.paintings.map(async (p) => {
            const curve = await c.env.PAINTING.getByName(p.id).scoreCurve();
            return [p.id, downsample(curve as [number, number][], CURVE_POINTS)] as const;
          }),
        ),
      );
      const first = selected.paintings[0];
      const detail: TestDetail = {
        reference,
        ...selected,
        series,
        anchors: { blank: first?.blankScore ?? null, meanColor: first?.meanColorScore ?? null },
        curves,
        table: seriesTable(selected.paintings),
      };
      return c.json(detail);
    },
    ["condition", "series"],
  );
});

// Pages (static HTML that reads the API).
app.get("/p/:id", (c) => c.env.ASSETS.fetch(new Request(new URL("/painting", c.req.url))));
app.get("/tests", (c) => c.env.ASSETS.fetch(new Request(new URL("/tests", c.req.url))));
app.get("/tests/:reference", (c) => c.env.ASSETS.fetch(new Request(new URL("/tests", c.req.url))));

// Pooled endpoint: bearer-token agents, any pool painting.
app.all("/mcp", tooLarge, async (c) => {
  const agent = authenticate(c.req.header("Authorization"), c.env.MCP_TOKENS);
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="agentpaint"' });
  }
  const { success } = await c.env.MCP_LIMITER.limit({ key: agent.name });
  if (!success) return c.json({ error: "rate limited" }, 429, { "Retry-After": "60" });
  const parsed = await rpcBody(c);
  if (parsed instanceof Response) return parsed;
  return handleMcp(c.req.raw, c.env, agent, parsed.body);
});

// Scoped endpoint: one created painting. The agent key is in the path (some MCP
// clients can't set headers) or a Bearer token; it is checked by the painting.
const scopedLimit = bodyLimit({
  maxSize: 1024 * 1024,
  onError: (c) => c.json({ error: "request body too large" }, 413),
});
async function scoped(c: AppContext, id: string, key: string | undefined) {
  if (!PAINTING_ID.test(id) || !key || !KEY.test(key)) {
    return c.json({ error: "unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="agentpaint"' });
  }
  // Painting ids are public, so requests are limited per client before the key
  // is checked, and the painting's own limit is charged only once it is.
  const ip = c.req.header("CF-Connecting-IP") ?? "local";
  const client = await c.env.SCOPED_CLIENT_LIMITER.limit({ key: `${ip}:${id}` });
  if (!client.success) return c.json({ error: "rate limited" }, 429, { "Retry-After": "60" });
  if (!(await c.env.PAINTING.getByName(id).verifyAgentKey(key))) {
    return c.json({ error: "unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="agentpaint"' });
  }
  const painting = await c.env.SCOPED_LIMITER.limit({ key: id });
  if (!painting.success) return c.json({ error: "rate limited" }, 429, { "Retry-After": "60" });
  const parsed = await rpcBody(c);
  if (parsed instanceof Response) return parsed;
  return handleScopedMcp(c.req.raw, c.env, id, parsed.body);
}
app.all("/mcp/p/:id/:key", scopedLimit, (c) => scoped(c, c.req.param("id"), c.req.param("key")));
app.all("/mcp/p/:id", scopedLimit, (c) =>
  scoped(c, c.req.param("id"), bearer(c.req.header("Authorization"))),
);

app.notFound((c) => c.json({ error: "not found" }, 404));

export default app;
