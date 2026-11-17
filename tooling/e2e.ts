// End-to-end check against a running Worker (default: `bun run dev` on :8787).
//
//   AGENTPAINT_URL=http://127.0.0.1:8787 AGENTPAINT_TOKEN=... bun tooling/e2e.ts
//
// Without AGENTPAINT_TOKEN, the token is read from apps/worker/.dev.vars.

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const base = (process.env.AGENTPAINT_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const devTokens = process.env.AGENTPAINT_TOKEN ? [] : await readDevTokens();
const token = process.env.AGENTPAINT_TOKEN ?? devTokens[0];
// A second agent's token, for checks that tokens are bound to their agent.
const otherToken = process.env.AGENTPAINT_OTHER_TOKEN ?? devTokens[1];
if (!token) throw new Error("set AGENTPAINT_TOKEN, or MCP_TOKENS in apps/worker/.dev.vars");

async function readDevTokens(): Promise<string[]> {
  const vars = await Bun.file(new URL("../apps/worker/.dev.vars", import.meta.url)).text();
  const entries = /MCP_TOKENS=([^\n]+)/.exec(vars)?.[1]?.split(",") ?? [];
  return entries.map((e) => e.trim()).map((e) => e.slice(e.indexOf(":") + 1));
}

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`,
  );
  if (!ok) failures++;
}

async function connect(bearer: string) {
  const client = new Client({ name: "agentpaint-e2e", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    }),
  );
  return client;
}

type Content = { type: string; text?: string; data?: string; mimeType?: string };

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Content[];
  const textBlock = content.find((c) => c.type === "text");
  return { result, content, json: textBlock?.text ? JSON.parse(textBlock.text) : undefined };
}

/** JPEG signature and frame size (from the first SOF0 marker). */
function jpegSize(b64: string) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const signature = bytes[0] === 0xff && bytes[1] === 0xd8;
  for (let i = 2; i + 8 < bytes.length; ) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1] ?? 0;
    const length = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    if (marker === 0xc0 || marker === 0xc2) {
      const height = ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0);
      const width = ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0);
      return { signature, width, height };
    }
    i += 2 + length;
  }
  return { signature, width: 0, height: 0 };
}

function bigStroke(meta: { canvas_width: number; canvas_height: number; min_brush_size: number }, y: number) {
  return {
    points: [
      { x: 0, y, pressure: 0.9 },
      { x: meta.canvas_width / 2, y: y + 40, pressure: 1 },
      { x: meta.canvas_width, y, pressure: 0.9 },
    ],
    brush: { size: Math.max(meta.min_brush_size, 60), hardness: 0.5, opacity: 1, flow: 0.9 },
    color: { r: 40, g: 90, b: 160 },
  };
}

// --- Auth ---
const unauth = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
check("MCP rejects missing token", unauth.status === 401, unauth.status);
const badAuth = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { Authorization: `Bearer ${"x".repeat(token.length)}` },
  body: "{}",
});
check("MCP rejects wrong token", badAuth.status === 401, badAuth.status);
const batch = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  },
  body: JSON.stringify([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_assignment", arguments: {} } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_assignment", arguments: {} } },
  ]),
});
check("MCP rejects JSON-RPC batches", batch.status === 400, batch.status);

// --- Tools ---
const client = await connect(token);
const tools = await client.listTools();
check(
  "lists get_assignment and submit_stroke",
  ["get_assignment", "submit_stroke"].every((n) => tools.tools.some((t) => t.name === n)),
  tools.tools.map((t) => t.name),
);

const first = await call(client, "get_assignment");
const meta = first.json;
const image = first.content.find((c) => c.type === "image");
check(
  "assignment has a token and phase",
  typeof meta?.token === "string" && typeof meta?.phase === "string",
  meta,
);
const jpeg = image?.data ? jpegSize(image.data) : undefined;
check(
  "assignment includes the canvas image",
  image?.mimeType === "image/jpeg" && jpeg?.signature === true && jpeg.width === meta?.canvas_width,
  jpeg,
);
check("new painting starts at stroke 0", meta?.stroke_count === 0, meta?.stroke_count);

const paintingId = String(meta.token).split("-")[0];
const tiny = bigStroke(meta, 300);
tiny.brush.size = 1;
const tooSmall = await call(client, "submit_stroke", { token: meta.token, stroke_data: tiny });
check(
  "rejects a brush below the phase minimum",
  tooSmall.result.isError === true && tooSmall.json?.reason === "brush_too_small",
  tooSmall.json,
);

const offCanvas = bigStroke(meta, 300);
offCanvas.points[0] = { x: -500, y: 300, pressure: 1 };
const outside = await call(client, "submit_stroke", { token: meta.token, stroke_data: offCanvas });
check("rejects points outside the canvas", outside.json?.reason === "invalid_stroke", outside.json);

const badSchema = await client.callTool({
  name: "submit_stroke",
  arguments: { token: meta.token, stroke_data: { points: [] } },
});
check("schema validation rejects malformed strokes", badSchema.isError === true, badSchema.content);

const applied = await call(client, "submit_stroke", { token: meta.token, stroke_data: bigStroke(meta, 300) });
check(
  "applies a valid stroke after rejections",
  applied.json?.applied === true && applied.json?.stroke_count === 1,
  applied.json,
);

const reuse = await call(client, "submit_stroke", { token: meta.token, stroke_data: bigStroke(meta, 500) });
check("a token paints only once", reuse.json?.reason === "token_used", reuse.json);

if (otherToken) {
  const other = await connect(otherToken);
  const a = await call(client, "get_assignment");
  const stolen = await call(other, "submit_stroke", {
    token: a.json.token,
    stroke_data: bigStroke(a.json, 400),
  });
  check("another agent can't use my token", stolen.json?.reason === "invalid_token", stolen.json);
  const mine = await call(client, "submit_stroke", {
    token: a.json.token,
    stroke_data: bigStroke(a.json, 400),
  });
  check("...and it still works for me", mine.json?.applied === true, mine.json);
  await other.close();
} else {
  console.log("skip agent-binding check (no second token)");
}

const forged = await call(client, "submit_stroke", {
  token: `${paintingId}-${"A".repeat(20)}`,
  stroke_data: bigStroke(meta, 500),
});
check("rejects a forged token", forged.json?.reason === "invalid_token", forged.json);

// --- Leases: while one assignment is outstanding, the next goes to another painting ---
const second = await call(client, "get_assignment");
const third = await call(client, "get_assignment");
const secondId = String(second.json?.token).split("-")[0];
const thirdId = String(third.json?.token).split("-")[0];
check("concurrent assignments get different paintings", secondId !== thirdId, [secondId, thirdId]);
const done = await call(client, "submit_stroke", {
  token: third.json.token,
  stroke_data: bigStroke(third.json, 200),
});
check("second agent's stroke applies", done.json?.applied === true, done.json);

// Painting the same canvas again continues from where it left off.
const strokes = [];
for (let i = 0; i < 3; i++) {
  const a = await call(client, "get_assignment");
  const r = await call(client, "submit_stroke", {
    token: a.json.token,
    stroke_data: bigStroke(a.json, 100 + i * 250),
  });
  strokes.push(r.json?.applied);
}
check("repeated assignments keep painting", strokes.every(Boolean), strokes);

// --- Gallery API ---
const list = (await (await fetch(`${base}/api/paintings`)).json()) as { id: string; strokeCount: number }[];
const listed = list.find((p) => p.id === paintingId);
check("gallery lists the painting with its stroke count", (listed?.strokeCount ?? 0) >= 1, listed);
const snap = await fetch(`${base}/api/paintings/${paintingId}/v/1`);
check(
  "serves the stroke's snapshot",
  snap.status === 200 && snap.headers.get("content-type") === "image/jpeg",
  snap.status,
);
// The second fetch of the same URL is served from the edge cache.
const again = await fetch(`${base}/api/paintings/${paintingId}/v/1`);
check(
  "serves a cached snapshot again",
  again.status === 200 && again.headers.get("x-content-type-options") === "nosniff",
  again.status,
);
const listAgain = await fetch(`${base}/api/paintings`);
check("serves the cached painting list again", listAgain.status === 200, listAgain.status);
const blank = await fetch(`${base}/api/paintings/${paintingId}/v/0`);
check("serves the blank starting canvas", blank.status === 200, blank.status);
const traversal = await fetch(`${base}/api/paintings/..%2F..%2Fx/v/1`);
check("rejects malformed painting ids", traversal.status === 404, traversal.status);
const page = await fetch(`${base}/`);
check(
  "serves the gallery page",
  page.status === 200 && (page.headers.get("content-type") ?? "").includes("text/html"),
);

await client.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
