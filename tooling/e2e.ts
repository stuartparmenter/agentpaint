// End-to-end check against a running Worker (default: `bun run dev` on :8787).
//
//   AGENTPAINT_URL=http://127.0.0.1:8787 AGENTPAINT_TOKEN=... bun tooling/e2e.ts
//
// Without AGENTPAINT_TOKEN, the token is read from apps/worker/.dev.vars.

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// biome-ignore lint/suspicious/noExplicitAny: JSON from tool results and the API is untyped.
type Json = Record<string, any>;

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
const startCount: number = meta?.stroke_count;
check("the assignment reports the stroke count", Number.isInteger(startCount) && startCount >= 0, startCount);

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
  applied.json?.applied === true && applied.json?.stroke_count === startCount + 1,
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
// The list is cached for a few seconds, so a painting made just now may not be in it yet.
let listed: { id: string; strokeCount: number } | undefined;
for (let attempt = 0; attempt < 4 && !listed?.strokeCount; attempt++) {
  if (attempt) await Bun.sleep(2000);
  const list = (await (await fetch(`${base}/api/paintings`)).json()) as { id: string; strokeCount: number }[];
  listed = list.find((p) => p.id === paintingId);
}
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

// --- Created paintings and the scoped endpoint ---------------------------------

// A random documentation address (TEST-NET-3). Under `wrangler dev` it stands in
// for the client's address, so each creation counts against its own per-client
// cap and repeated runs don't accumulate; behind Cloudflare the header is
// replaced with the real address.
function testAddress() {
  return `203.0.113.${1 + Math.floor(Math.random() * 254)}`;
}

async function create(settings: Record<string, unknown>, address = testAddress()) {
  const res = await fetch(`${base}/api/paintings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": address },
    body: JSON.stringify(settings),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

async function connectUrl(url: string, headers: Record<string, string> = {}) {
  const c = new Client({ name: "agentpaint-e2e", version: "0.1.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return c;
}

// Every MCP response a painter sees, to check the score never leaks to it.
const painterTexts: string[] = [];
async function scopedCall(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await call(c, name, args);
  for (const block of r.content) if (block.text) painterTexts.push(block.text);
  return r;
}

function studyStroke(x: number, y: number, note?: string) {
  return {
    points: [
      { x, y, pressure: 0.9 },
      { x: x + 120, y: y + 20, pressure: 1 },
    ],
    brush: { size: 40, hardness: 0.6, opacity: 1, flow: 0.9 },
    color: { r: 200, g: 120, b: 160 },
    ...(note ? { note } : {}),
  };
}

const bad = await create({ style: "landscape", reference: "no-such-reference" });
check("creation rejects an unknown reference", bad.status === 400, bad);
const tooBig = await create({ style: "landscape", size: "study", strokes_per_look: 9999 });
check("creation rejects strokes_per_look above the budget", tooBig.status === 400, tooBig.status);

const made = await create({
  style: "landscape",
  reference: "krita-sunset",
  size: "study",
  strokes_per_look: 3,
  prompt: "e2e",
});
const p = made.body;
check(
  "creates a study with the reference's aspect ratio",
  made.status === 201 &&
    p.settings?.width === 512 &&
    p.settings?.height === 288 &&
    p.settings?.kind === "created",
  made.status,
);
check(
  "returns keys, an MCP URL and a new series",
  typeof p.agent_key === "string" &&
    typeof p.owner_key === "string" &&
    p.mcp_url?.endsWith(`/mcp/p/${p.id}/${p.agent_key}`) &&
    !!p.series_key,
);

const wrongKey = await fetch(`${base}/mcp/p/${p.id}/${"A".repeat(32)}`, { method: "POST", body: "{}" });
check("scoped endpoint rejects a wrong key", wrongKey.status === 401, wrongKey.status);
const noKey = await fetch(`${base}/mcp/p/${p.id}`, { method: "POST", body: "{}" });
check("scoped endpoint rejects a missing key", noKey.status === 401, noKey.status);
const poolKeyOnScoped = await fetch(`${base}/mcp/p/${p.id}`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  body: "{}",
});
check("a pool token doesn't open a scoped endpoint", poolKeyOnScoped.status === 401, poolKeyOnScoped.status);

const scopedClient = await connectUrl(p.mcp_url);
const look1 = await scopedCall(scopedClient, "get_assignment");
const kinds = look1.content.map((c) =>
  c.type === "text" ? (c.text?.startsWith("{") ? "meta" : c.text) : c.type,
);
check(
  "a new look shows the labeled reference and canvas",
  JSON.stringify(kinds) === JSON.stringify(["meta", "Reference image:", "image", "Current canvas:", "image"]),
  kinds,
);
const m1 = look1.json;
check(
  "look metadata reports the allowance and omits phase fields when phases are off",
  m1.strokes_remaining === 3 &&
    m1.new_look === true &&
    m1.look === 1 &&
    !("phase" in m1) &&
    !("min_brush_size" in m1),
  m1,
);
const canvasImage = look1.content.filter((c) => c.type === "image")[1];
const canvasSize = canvasImage?.data ? jpegSize(canvasImage.data) : undefined;
check(
  "the canvas image has the painting's size",
  canvasSize?.width === 512 && canvasSize?.height === 288,
  canvasSize,
);

const sameLook = await scopedCall(scopedClient, "get_assignment");
check(
  "while a look has strokes left, get_assignment returns the same token without images",
  sameLook.json?.token === m1.token &&
    sameLook.json?.new_look === false &&
    sameLook.content.every((c) => c.type === "text"),
  sameLook.json,
);

const halfBad = await scopedCall(scopedClient, "submit_stroke", {
  token: m1.token,
  strokes: [
    studyStroke(20, 40),
    {
      ...studyStroke(20, 80),
      points: [
        { x: 9999, y: 1, pressure: 1 },
        { x: 1, y: 1, pressure: 1 },
      ],
    },
  ],
});
check(
  "a batch with an invalid stroke applies nothing and names its index",
  halfBad.json?.applied === false && halfBad.json?.applied_count === 0 && halfBad.json?.index === 1,
  halfBad.json,
);
const overSize = await scopedCall(scopedClient, "submit_stroke", {
  token: m1.token,
  stroke_data: { ...studyStroke(20, 40), brush: { size: 150, hardness: 0.5, opacity: 1, flow: 1 } },
});
check("brush size is capped for the canvas width", overSize.json?.reason === "invalid_stroke", overSize.json);

const applied2 = await scopedCall(scopedClient, "submit_stroke", {
  token: m1.token,
  strokes: [studyStroke(20, 40, "sky band"), studyStroke(40, 120, "horizon")],
  model: "e2e-model",
  effort: "low",
  input_tokens: 123,
  output_tokens: 45,
  prompt_hash: "abc123",
});
check(
  "a valid batch applies and reports what's left",
  applied2.json?.applied === true &&
    applied2.json?.applied_count === 2 &&
    applied2.json?.strokes_remaining === 1,
  applied2.json,
);
const overAllowance = await scopedCall(scopedClient, "submit_stroke", {
  token: m1.token,
  strokes: [studyStroke(60, 160), studyStroke(60, 200)],
});
check(
  "a batch can't exceed the look's allowance",
  overAllowance.json?.reason === "too_many_strokes",
  overAllowance.json,
);
const last = await scopedCall(scopedClient, "submit_stroke", {
  token: m1.token,
  stroke_data: studyStroke(60, 160),
  note: "water",
});
check(
  "the last stroke of a look uses it up",
  last.json?.applied === true && last.json?.strokes_remaining === 0,
  last.json,
);
const used = await scopedCall(scopedClient, "submit_stroke", {
  token: m1.token,
  stroke_data: studyStroke(60, 200),
});
check("a used-up look's token paints no more", used.json?.reason === "token_used", used.json);

const look2 = await scopedCall(scopedClient, "get_assignment");
check(
  "the next look is a fresh look with images",
  look2.json?.new_look === true &&
    look2.json?.token !== m1.token &&
    look2.json?.look === 2 &&
    look2.content.some((c) => c.type === "image"),
  look2.json,
);
const finish = await scopedCall(scopedClient, "submit_stroke", {
  token: look2.json.token,
  stroke_data: studyStroke(200, 200),
  finished: true,
});
check(
  "finished: true ends the painting",
  finish.json?.applied === true && finish.json?.status === "done",
  finish.json,
);
const afterFinish = await scopedCall(scopedClient, "get_assignment");
check("a finished painting hands out no looks", afterFinish.json?.available === false, afterFinish.json);
await scopedClient.close();

const log = (await (await fetch(`${base}/api/paintings/${p.id}/strokes`)).json()) as Json[];
check("the stroke log has every applied stroke", log.length === 4, log.length);
check(
  "the log records looks, notes, think time and scores",
  log[0]?.look === 1 &&
    log[3]?.look === 2 &&
    log[0]?.note === "sky band" &&
    log[2]?.note === "water" &&
    log.every((s) => typeof s.think_ms === "number" && s.think_ms >= 0 && typeof s.score === "number"),
  log,
);
check(
  "self-reported fields are recorded, token counts once per submission",
  log[0]?.model === "e2e-model" &&
    log[0]?.effort === "low" &&
    log[0]?.input_tokens === 123 &&
    log[1]?.input_tokens === null &&
    log[0]?.prompt_hash === "abc123",
  log[0],
);
check(
  "the score never reaches the painter",
  painterTexts.every((t) => !/score/i.test(t)),
  painterTexts.filter((t) => /score/i.test(t)),
);

const replayCheck = await fetch(`${base}/api/paintings/${p.id}/v/4`);
check("snapshots exist for batched strokes", replayCheck.status === 200, replayCheck.status);
const refImage = await fetch(`${base}/api/paintings/${p.id}/reference`);
check("serves the painting's reference image", refImage.status === 200, refImage.status);

const verifyAsAgent = await fetch(`${base}/api/paintings/${p.id}/verify`, {
  method: "POST",
  headers: { Authorization: `Bearer ${p.agent_key}` },
});
check("only the owner can run the replay check", verifyAsAgent.status === 401, verifyAsAgent.status);
const verified = (await (
  await fetch(`${base}/api/paintings/${p.id}/verify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${p.owner_key}` },
  })
).json()) as Json;
check(
  "the stroke log replays to the stored snapshot",
  verified.fromScratch === true && verified.version === 4,
  verified,
);

// Siblings, series and owner finish.
const wrongSeries = await create({
  style: "landscape",
  size: "study",
  series: p.series_id,
  series_key: "B".repeat(32),
});
check("adding to a series needs its key", wrongSeries.status === 403, wrongSeries.status);
const sibling = await create({
  style: "landscape",
  reference: "krita-sunset",
  size: "study",
  strokes_per_look: 250,
  phases: "enforced",
  series: p.series_id,
  series_key: p.series_key,
});
check(
  "a sibling joins the series",
  sibling.status === 201 && sibling.body.series_id === p.series_id && sibling.body.series_key === null,
  sibling.body.series_id,
);
const sib = await connectUrl(`${base}/mcp/p/${sibling.body.id}`, {
  Authorization: `Bearer ${sibling.body.agent_key}`,
});
const sibLook = await scopedCall(sib, "get_assignment");
check(
  "enforced phases send the brush floor, scaled to the canvas",
  sibLook.json?.min_brush_size === 60 &&
    typeof sibLook.json?.phase === "string" &&
    sibLook.json?.strokes_remaining === 250,
  sibLook.json,
);
await sib.close();
const notOwner = await fetch(`${base}/api/paintings/${sibling.body.id}/finish`, {
  method: "POST",
  headers: { Authorization: `Bearer ${sibling.body.agent_key}` },
});
check("only the owner key finishes a painting", notOwner.status === 401, notOwner.status);
const owner = await fetch(`${base}/api/paintings/${sibling.body.id}/finish`, {
  method: "POST",
  headers: { Authorization: `Bearer ${sibling.body.owner_key}` },
});
check("the owner key finishes it", owner.status === 200, owner.status);

const series = (await (await fetch(`${base}/api/series/${p.series_id}`)).json()) as Json;
check(
  "the series lists both paintings with a results table",
  series.paintings?.length === 2 && Array.isArray(series.table) && series.table.length === 2,
  series,
);
const cell = series.table?.find((c: Json) => c.strokes_per_look === 3);
check(
  "results include the final score and think time",
  typeof cell?.final_score === "number" && typeof cell?.mean_think_ms === "number",
  cell,
);

// The pool never hands out created paintings.
const poolClient = await connect(token);
const poolLook = await call(poolClient, "get_assignment");
const poolId = String(poolLook.json?.token).split("-")[0];
check("the pool doesn't hand out created paintings", poolId !== p.id && poolId !== sibling.body.id, poolId);
const crossed = await call(poolClient, "submit_stroke", {
  token: look2.json.token,
  stroke_data: bigStroke(poolLook.json, 300),
});
check(
  "a scoped token doesn't work on the pool endpoint",
  crossed.json?.reason === "invalid_token",
  crossed.json,
);
await poolClient.close();

// Painting ids are public: a stranger sending bad keys gets limited, without
// using up the painting's own allowance.
const target = await create({ style: "landscape", size: "study", max_strokes: 5, strokes_per_look: 5 });
const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
let strangerStatus = 0;
for (let i = 0; i < 125 && strangerStatus !== 429; i++) {
  const res = await fetch(`${base}/mcp/p/${target.body.id}/${"0".repeat(32)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "CF-Connecting-IP": "192.0.2.66",
    },
    body: JSON.stringify(ping),
  });
  strangerStatus = res.status;
  await res.body?.cancel();
}
check("a client sending bad keys is rate limited", strangerStatus === 429, strangerStatus);
const keyHolder = await connectUrl(target.body.mcp_url, { "CF-Connecting-IP": "192.0.2.77" });
const ownerLook = await scopedCall(keyHolder, "get_assignment");
check("the agent key still works for its own client", !!ownerLook.json?.token, ownerLook.json);
await keyHolder.close();

const isHtml = (res: Response) =>
  res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/html");
for (const [name, path] of [
  ["the painting page", `/p/${p.id}`],
  ["the tests index", "/tests"],
  ["a reference test page", "/tests/krita-sunset"],
  ["a test page for one batch of runs", `/tests/krita-sunset?series=${p.series_id}`],
  ["the test page for an unknown reference (it reports the error)", "/tests/no-such-reference"],
]) {
  const res = await fetch(`${base}${path}`);
  check(`serves ${name}`, isHtml(res), res.status);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
