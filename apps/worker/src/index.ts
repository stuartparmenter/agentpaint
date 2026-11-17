import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authenticate } from "./auth";
import { PAINTING_ID } from "./ids";
import { handleMcp } from "./mcp";
import { snapshotKey } from "./painting";
import { mixingModel, rendererVersion } from "./renderer";

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
async function cached(c: AppContext, ttlSeconds: number, produce: () => Promise<Response>) {
  const cache = caches.default;
  const hit = await cache.match(c.req.raw);
  // Cached responses have immutable headers; hand back a mutable copy.
  if (hit) return new Response(hit.body, hit);
  const response = await produce();
  if (response.ok) {
    const copy = new Response(response.body, response);
    copy.headers.set(
      "Cache-Control",
      ttlSeconds >= 3600 ? `public, max-age=${ttlSeconds}, immutable` : `public, max-age=${ttlSeconds}`,
    );
    c.executionCtx.waitUntil(cache.put(c.req.raw, copy.clone()));
    return copy;
  }
  return response;
}

app.get("/api/health", (c) => c.json({ ok: true, renderer: rendererVersion(), mixing: mixingModel() }));

app.get("/api/paintings", (c) =>
  cached(c, 4, async () => c.json(await c.env.REGISTRY.getByName("registry").list(100))),
);

app.get("/api/paintings/:id", async (c) => {
  const id = c.req.param("id");
  if (!PAINTING_ID.test(id)) return c.notFound();
  return cached(c, 4, async () => {
    const painting = await c.env.REGISTRY.getByName("registry").get(id);
    return painting ? c.json(painting) : c.notFound();
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

app.all(
  "/mcp",
  bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "request body too large" }, 413) }),
  async (c) => {
    const agent = authenticate(c.req.header("Authorization"), c.env.MCP_TOKENS);
    if (!agent) {
      return c.json({ error: "unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="agentpaint"' });
    }
    const { success } = await c.env.MCP_LIMITER.limit({ key: agent.name });
    if (!success) return c.json({ error: "rate limited" }, 429, { "Retry-After": "60" });

    let parsedBody: unknown;
    if (c.req.method === "POST") {
      try {
        parsedBody = await c.req.json();
      } catch {
        return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
      }
      // JSON-RPC batches would let one rate-limited request run many tool calls.
      if (Array.isArray(parsedBody)) {
        return c.json(
          { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch requests are not supported" } },
          400,
        );
      }
    }
    return handleMcp(c.req.raw, c.env, agent, parsedBody);
  },
);

app.notFound((c) => c.json({ error: "not found" }, 404));

export default app;
