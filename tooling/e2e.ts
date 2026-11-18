// End-to-end check against a running Worker (default: `bun run dev` on :8787).
//
//   AGENTPAINT_URL=http://127.0.0.1:8787 bun tooling/e2e.ts

import type { Client } from "@modelcontextprotocol/client";
import { connect, firstJson, type Json, type McpContent } from "../tools/painter/src/mcp";

const base = (process.env.AGENTPAINT_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`,
  );
  if (!ok) failures++;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as McpContent[];
  return { result, content, json: firstJson(content) };
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

function decode(b64: string | undefined): Uint8Array | null {
  return b64 ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : null;
}

/** The body of a GET, or null when it isn't 200. */
async function fetchBytes(path: string): Promise<Uint8Array | null> {
  const res = await fetch(`${base}${path}`);
  return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null) {
  return !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The text labels and image kinds of a get_assignment result, in order. */
function contentKinds(content: McpContent[]) {
  return content.map((c) => (c.type === "text" ? (c.text?.startsWith("{") ? "meta" : c.text) : c.type));
}

/** The images of a get_assignment result: the reference (when there is one), then the canvas. */
function assignmentImages(content: McpContent[]) {
  const images = content.filter((c) => c.type === "image").map((c) => decode(c.data));
  return { reference: images.length === 2 ? (images[0] ?? null) : null, canvas: images.at(-1) ?? null };
}

const OPEN_KINDS = ["meta", "Reference image:", "image", "Canvas when this assignment started:", "image"];

function bigStroke(meta: { canvas_width: number; canvas_height: number }, y: number) {
  return {
    points: [
      { x: 0, y, pressure: 0.9 },
      { x: meta.canvas_width / 2, y: y + 40, pressure: 1 },
      { x: meta.canvas_width, y, pressure: 0.9 },
    ],
    brush: { size: 60, hardness: 0.5, opacity: 1, flow: 0.9 },
    color: { r: 40, g: 90, b: 160 },
  };
}

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

// --- A painting without a reference ---------------------------------------------

const plain = await create({ style: "landscape", prompt: "a harbor at dawn", max_strokes: 20 });
const q = plain.body;
check(
  "creates a full-size painting without a reference",
  plain.status === 201 &&
    q.settings?.width === 1024 &&
    q.settings?.height === 1024 &&
    q.settings?.reference === null &&
    q.settings?.prompt === "a harbor at dawn",
  plain,
);

const rpcHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const batch = await fetch(q.mcp_url, {
  method: "POST",
  headers: rpcHeaders,
  body: JSON.stringify([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_assignment", arguments: {} } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_assignment", arguments: {} } },
  ]),
});
check("MCP rejects JSON-RPC batches", batch.status === 400, batch.status);

const client = await connect(new URL(q.mcp_url));
const tools = await client.listTools();
check(
  "lists get_assignment and submit_stroke",
  ["get_assignment", "submit_stroke"].every((n) => tools.tools.some((t) => t.name === n)),
  tools.tools.map((t) => t.name),
);

const first = await scopedCall(client, "get_assignment");
const meta = first.json;
const firstKinds = contentKinds(first.content);
check(
  "a new assignment without a reference shows only the canvas",
  JSON.stringify(firstKinds) === JSON.stringify(["meta", "Current canvas:", "image"]),
  firstKinds,
);
check(
  "the assignment has a token, the prompt and the canvas's max_brush_size",
  typeof meta?.token === "string" &&
    meta?.prompt === "a harbor at dawn" &&
    meta?.has_reference === false &&
    meta?.max_brush_size === 200 &&
    meta?.stroke_count === 0,
  meta,
);
const image = first.content.find((c) => c.type === "image");
const jpeg = image?.data ? jpegSize(image.data) : undefined;
check(
  "the assignment includes the canvas image",
  image?.mimeType === "image/jpeg" && jpeg?.signature === true && jpeg.width === 1024 && jpeg.height === 1024,
  jpeg,
);

const huge = bigStroke(meta, 300);
huge.brush.size = meta.max_brush_size + 1;
const bigBrush = await scopedCall(client, "submit_stroke", { token: meta.token, stroke_data: huge });
check("rejects a brush above max_brush_size", bigBrush.result.isError === true, bigBrush.content);

const offCanvas = bigStroke(meta, 300);
offCanvas.points[0] = { x: -500, y: 300, pressure: 1 };
const outside = await scopedCall(client, "submit_stroke", { token: meta.token, stroke_data: offCanvas });
check("rejects points outside the canvas", outside.json?.reason === "invalid_stroke", outside.json);

const badSchema = await client.callTool({
  name: "submit_stroke",
  arguments: { token: meta.token, stroke_data: { points: [] } },
});
check("schema validation rejects malformed strokes", badSchema.isError === true, badSchema.content);

const applied = await scopedCall(client, "submit_stroke", {
  token: meta.token,
  stroke_data: bigStroke(meta, 300),
});
check(
  "applies a valid stroke after rejections",
  applied.json?.applied === true && applied.json?.stroke_count === 1,
  applied.json,
);

const reuse = await scopedCall(client, "submit_stroke", {
  token: meta.token,
  stroke_data: bigStroke(meta, 500),
});
check("a one-stroke assignment's token paints once", reuse.json?.reason === "token_used", reuse.json);

const forged = await scopedCall(client, "submit_stroke", {
  token: `${q.id}-${"A".repeat(20)}`,
  stroke_data: bigStroke(meta, 500),
});
check("rejects a forged token", forged.json?.reason === "invalid_token", forged.json);

// Each used-up assignment is followed by a new one showing the canvas.
const repeated = [];
for (let i = 0; i < 3; i++) {
  const a = await scopedCall(client, "get_assignment");
  const r = await scopedCall(client, "submit_stroke", {
    token: a.json.token,
    stroke_data: bigStroke(a.json, 100 + i * 250),
  });
  repeated.push(
    a.json.new_assignment === true && a.content.some((c) => c.type === "image") && r.json?.applied,
  );
}
check("repeated assignments keep painting", repeated.every(Boolean), repeated);
const qOpen = (await scopedCall(client, "get_assignment")).json;
await client.close();

// --- A painting against a reference ----------------------------------------------

const bad = await create({ style: "landscape", reference: "no-such-reference" });
check("creation rejects an unknown reference", bad.status === 400, bad);
const tooBig = await create({ style: "landscape", size: "study", strokes_per_assignment: 9999 });
check("creation rejects strokes_per_assignment above the budget", tooBig.status === 400, tooBig.status);

const made = await create({
  style: "landscape",
  reference: "krita-sunset",
  size: "study",
  strokes_per_assignment: 3,
  prompt: "e2e",
});
const p = made.body;
check(
  "creates a study with the reference's aspect ratio",
  made.status === 201 && p.settings?.width === 512 && p.settings?.height === 288,
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
const otherKey = await fetch(`${base}/mcp/p/${p.id}`, {
  method: "POST",
  headers: { Authorization: `Bearer ${q.agent_key}` },
  body: "{}",
});
check("another painting's agent key doesn't open this endpoint", otherKey.status === 401, otherKey.status);

const scopedClient = await connect(new URL(p.mcp_url));
const assignment1 = await scopedCall(scopedClient, "get_assignment");
const kinds = contentKinds(assignment1.content);
check(
  "a new assignment shows the labeled reference and canvas",
  JSON.stringify(kinds) === JSON.stringify(["meta", "Reference image:", "image", "Current canvas:", "image"]),
  kinds,
);
const m1 = assignment1.json;
check(
  "assignment metadata reports both counts",
  m1.assignment_strokes_remaining === 3 &&
    m1.painting_strokes_remaining === m1.max_strokes &&
    m1.max_strokes > 3 &&
    m1.new_assignment === true &&
    m1.assignment === 1,
  m1,
);
check("assignment metadata names the painting", m1.painting_id === p.id, m1.painting_id);
const crossed = await scopedCall(scopedClient, "submit_stroke", {
  token: qOpen.token,
  stroke_data: studyStroke(20, 40),
});
check("another painting's token is rejected", crossed.json?.reason === "invalid_token", crossed.json);
const canvasImage = assignment1.content.filter((c) => c.type === "image")[1];
const canvasSize = canvasImage?.data ? jpegSize(canvasImage.data) : undefined;
check(
  "the canvas image has the painting's size",
  canvasSize?.width === 512 && canvasSize?.height === 288,
  canvasSize,
);

const sameAssignment = await scopedCall(scopedClient, "get_assignment");
const sameImages = assignmentImages(sameAssignment.content);
const firstImages = assignmentImages(assignment1.content);
check(
  "while an assignment has strokes left, get_assignment returns the same token and the images it started with",
  sameAssignment.json?.token === m1.token &&
    sameAssignment.json?.new_assignment === false &&
    JSON.stringify(contentKinds(sameAssignment.content)) === JSON.stringify(OPEN_KINDS) &&
    sameBytes(sameImages.reference, firstImages.reference) &&
    sameBytes(sameImages.canvas, firstImages.canvas),
  contentKinds(sameAssignment.content),
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
  stroke_data: {
    ...studyStroke(20, 40),
    brush: { size: m1.max_brush_size + 1, hardness: 0.5, opacity: 1, flow: 1 },
  },
});
check(
  "a brush above the assignment's max_brush_size is rejected",
  overSize.json?.reason === "invalid_stroke",
  overSize.json,
);

const applied2 = await scopedCall(scopedClient, "submit_stroke", {
  token: m1.token,
  strokes: [
    {
      ...studyStroke(20, 40, "sky band"),
      brush: { size: m1.max_brush_size, hardness: 0.5, opacity: 1, flow: 1 },
    },
    studyStroke(40, 120, "horizon"),
  ],
  model: "e2e-model",
  effort: "low",
  input_tokens: 123,
  output_tokens: 45,
  prompt_hash: "abc123",
});
check(
  "a valid batch (one stroke at max_brush_size) applies and reports what's left in the assignment and the painting",
  applied2.json?.applied === true &&
    applied2.json?.applied_count === 2 &&
    applied2.json?.assignment_strokes_remaining === 1 &&
    applied2.json?.painting_strokes_remaining === m1.max_strokes - 2,
  applied2.json,
);
// A new MCP session (a new agent) on the half-used assignment sees its starting
// view: the blank canvas at version 0, not the two strokes painted since.
const resumed = await connect(new URL(p.mcp_url));
const resumedAssignment = await scopedCall(resumed, "get_assignment");
await resumed.close();
const resumedImages = assignmentImages(resumedAssignment.content);
const blankStart = await fetchBytes(`/api/paintings/${p.id}/v/0`);
check(
  "a repeat get_assignment after some strokes shows the canvas from the assignment's start (v0), not the current one",
  resumedAssignment.json?.token === m1.token &&
    resumedAssignment.json?.new_assignment === false &&
    resumedAssignment.json?.stroke_count === 2 &&
    JSON.stringify(contentKinds(resumedAssignment.content)) === JSON.stringify(OPEN_KINDS) &&
    sameBytes(resumedImages.canvas, blankStart) &&
    !sameBytes(resumedImages.canvas, await fetchBytes(`/api/paintings/${p.id}/v/2`)) &&
    sameBytes(resumedImages.reference, await fetchBytes(`/api/paintings/${p.id}/reference`)),
  contentKinds(resumedAssignment.content),
);

const overAllowance = await scopedCall(scopedClient, "submit_stroke", {
  token: m1.token,
  strokes: [studyStroke(60, 160), studyStroke(60, 200)],
});
check(
  "a batch can't exceed the assignment's allowance",
  overAllowance.json?.reason === "too_many_strokes",
  overAllowance.json,
);
const last = await scopedCall(scopedClient, "submit_stroke", {
  token: m1.token,
  stroke_data: studyStroke(60, 160),
  note: "water",
});
check(
  "the last stroke of an assignment uses it up",
  last.json?.applied === true && last.json?.assignment_strokes_remaining === 0,
  last.json,
);
const used = await scopedCall(scopedClient, "submit_stroke", {
  token: m1.token,
  stroke_data: studyStroke(60, 200),
});
check("a used-up assignment's token paints no more", used.json?.reason === "token_used", used.json);

const assignment2 = await scopedCall(scopedClient, "get_assignment");
check(
  "the next assignment is a new one with images, a fresh allowance and the painting's remaining budget",
  assignment2.json?.new_assignment === true &&
    assignment2.json?.token !== m1.token &&
    assignment2.json?.assignment === 2 &&
    assignment2.json?.assignment_strokes_remaining === 3 &&
    assignment2.json?.painting_strokes_remaining === m1.max_strokes - 3 &&
    assignment2.content.some((c) => c.type === "image"),
  assignment2.json,
);
const finish = await scopedCall(scopedClient, "submit_stroke", {
  token: assignment2.json.token,
  stroke_data: studyStroke(200, 200),
  finished: true,
});
check(
  "finished: true ends the painting",
  finish.json?.applied === true && finish.json?.status === "done",
  finish.json,
);
const afterFinish = await scopedCall(scopedClient, "get_assignment");
check(
  "a finished painting hands out no assignments",
  afterFinish.json?.available === false,
  afterFinish.json,
);
await scopedClient.close();

const log = (await (await fetch(`${base}/api/paintings/${p.id}/strokes`)).json()) as Json[];
check("the stroke log has every applied stroke", log.length === 4, log.length);
check(
  "the log records assignments, notes, think time and scores",
  log[0]?.assignment === 1 &&
    log[2]?.assignment === 1 &&
    log[3]?.assignment === 2 &&
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

// --- An assignment that starts after earlier strokes -----------------------------

const later = await create({ style: "landscape", size: "study", max_strokes: 6, strokes_per_assignment: 3 });
const laterClient = await connect(new URL(later.body.mcp_url));
const laterFirst = (await scopedCall(laterClient, "get_assignment")).json;
await scopedCall(laterClient, "submit_stroke", {
  token: laterFirst.token,
  strokes: [studyStroke(20, 40), studyStroke(40, 120), studyStroke(60, 160)],
});
const laterSecond = await scopedCall(laterClient, "get_assignment");
await scopedCall(laterClient, "submit_stroke", {
  token: laterSecond.json.token,
  stroke_data: studyStroke(200, 200),
});
await laterClient.close();
const laterResumed = await connect(new URL(later.body.mcp_url));
const laterRepeat = await scopedCall(laterResumed, "get_assignment");
await laterResumed.close();
const laterCanvas = assignmentImages(laterRepeat.content).canvas;
check(
  "an open assignment that started at stroke 3 shows the v3 snapshot, not the v4 canvas",
  laterRepeat.json?.token === laterSecond.json.token &&
    laterRepeat.json?.new_assignment === false &&
    laterRepeat.json?.stroke_count === 4 &&
    JSON.stringify(contentKinds(laterRepeat.content)) ===
      JSON.stringify(["meta", "Canvas when this assignment started:", "image"]) &&
    sameBytes(laterCanvas, await fetchBytes(`/api/paintings/${later.body.id}/v/3`)) &&
    !sameBytes(laterCanvas, await fetchBytes(`/api/paintings/${later.body.id}/v/4`)),
  contentKinds(laterRepeat.content),
);
check(
  "a new assignment's canvas is the current one",
  sameBytes(
    assignmentImages(laterSecond.content).canvas,
    await fetchBytes(`/api/paintings/${later.body.id}/v/3`),
  ),
);

// --- A painting the agent can't end early ---------------------------------------

const mentionsFinishing = (text: string | undefined) => /finish/i.test(text ?? "");
const defaultSubmit = tools.tools.find((t) => t.name === "submit_stroke");
check(
  "by default the agent can end a painting early, and submit_stroke takes and describes finished",
  q.settings?.allowFinish === true &&
    "finished" in (defaultSubmit?.inputSchema.properties ?? {}) &&
    mentionsFinishing(defaultSubmit?.description),
  { settings: q.settings, submit: defaultSubmit },
);

const fixed = await create({
  style: "landscape",
  size: "study",
  max_strokes: 3,
  strokes_per_assignment: 3,
  allow_finish: false,
});
check(
  "creates a painting the agent can't end early",
  fixed.status === 201 && fixed.body.settings?.allowFinish === false,
  fixed,
);
const fixedClient = await connect(new URL(fixed.body.mcp_url));
const fixedTools = (await fixedClient.listTools()).tools;
const fixedSubmit = fixedTools.find((t) => t.name === "submit_stroke");
check(
  "its submit_stroke has no finished input",
  !!fixedSubmit && !("finished" in (fixedSubmit.inputSchema.properties ?? {})),
  fixedSubmit?.inputSchema,
);
check(
  "its tools and instructions don't mention finishing",
  fixedTools.length === 2 &&
    fixedTools.every((t) => !mentionsFinishing(t.description)) &&
    !mentionsFinishing(fixedClient.getInstructions()),
  fixedTools.map((t) => t.description),
);
const fixedMeta = (await scopedCall(fixedClient, "get_assignment")).json;
const finishAnyway = await scopedCall(fixedClient, "submit_stroke", {
  token: fixedMeta.token,
  strokes: [studyStroke(20, 40)],
  finished: true,
});
check(
  "finished: true sent anyway is rejected as an invalid submission and applies nothing",
  finishAnyway.result.isError === true &&
    finishAnyway.json?.reason === "invalid_stroke" &&
    /stroke budget/.test(finishAnyway.json?.detail ?? "") &&
    finishAnyway.json?.applied_count === 0 &&
    finishAnyway.json?.stroke_count === 0 &&
    finishAnyway.json?.status === "active" &&
    finishAnyway.json?.assignment_strokes_remaining === 3,
  finishAnyway.json,
);
const finishWithoutStrokes = await scopedCall(fixedClient, "submit_stroke", {
  token: fixedMeta.token,
  finished: true,
});
check(
  "finished: true without strokes is rejected the same way",
  finishWithoutStrokes.json?.reason === "invalid_stroke" &&
    /stroke budget/.test(finishWithoutStrokes.json?.detail ?? "") &&
    finishWithoutStrokes.json?.status === "active",
  finishWithoutStrokes.json,
);
const wholeBudget = await scopedCall(fixedClient, "submit_stroke", {
  token: fixedMeta.token,
  strokes: [studyStroke(20, 40), studyStroke(40, 120), studyStroke(60, 160)],
});
check(
  "the same token then paints, and the painting ends when its budget is used",
  wholeBudget.json?.applied_count === 3 && wholeBudget.json?.status === "done",
  wholeBudget.json,
);
await fixedClient.close();
const fixedLog = (await (await fetch(`${base}/api/paintings/${fixed.body.id}/strokes`)).json()) as Json[];
check("its stroke log has only the budget's strokes", fixedLog.length === 3, fixedLog.length);

// --- Gallery API ---
// The list is cached for a few seconds, so a painting made just now may not be in it yet.
let gallery: { id: string; strokeCount: number }[] = [];
let listed: { id: string; strokeCount: number } | undefined;
for (let attempt = 0; attempt < 4 && !listed?.strokeCount; attempt++) {
  if (attempt) await Bun.sleep(2000);
  gallery = (await (await fetch(`${base}/api/paintings`)).json()) as typeof gallery;
  listed = gallery.find((g) => g.id === q.id);
}
check(
  "the gallery lists a painting without a reference, with its stroke count",
  (listed?.strokeCount ?? 0) >= 1,
  listed,
);
check(
  "the gallery leaves out runs against a reference",
  !gallery.some((g) => g.id === p.id),
  gallery.map((g) => g.id),
);
const testRuns = (await (await fetch(`${base}/api/tests/krita-sunset?series=${p.series_id}`)).json()) as Json;
check(
  "the reference test lists the run",
  testRuns.paintings?.some((r: Json) => r.id === p.id),
  testRuns.paintings?.map((r: Json) => r.id),
);
const snap = await fetch(`${base}/api/paintings/${q.id}/v/1`);
check(
  "serves the stroke's snapshot",
  snap.status === 200 && snap.headers.get("content-type") === "image/jpeg",
  snap.status,
);
// The second fetch of the same URL is served from the edge cache.
const again = await fetch(`${base}/api/paintings/${q.id}/v/1`);
check(
  "serves a cached snapshot again",
  again.status === 200 && again.headers.get("x-content-type-options") === "nosniff",
  again.status,
);
const listAgain = await fetch(`${base}/api/paintings`);
check("serves the cached painting list again", listAgain.status === 200, listAgain.status);
const blank = await fetch(`${base}/api/paintings/${q.id}/v/0`);
check("serves the blank starting canvas", blank.status === 200, blank.status);
const traversal = await fetch(`${base}/api/paintings/..%2F..%2Fx/v/1`);
check("rejects malformed painting ids", traversal.status === 404, traversal.status);
const page = await fetch(`${base}/`);
check(
  "serves the gallery page",
  page.status === 200 && (page.headers.get("content-type") ?? "").includes("text/html"),
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
  strokes_per_assignment: 250,
  series: p.series_id,
  series_key: p.series_key,
});
check(
  "a sibling joins the series",
  sibling.status === 201 && sibling.body.series_id === p.series_id && sibling.body.series_key === null,
  sibling.body.series_id,
);
const sib = await connect(new URL(`${base}/mcp/p/${sibling.body.id}`), sibling.body.agent_key);
const sibAssignment = await scopedCall(sib, "get_assignment");
check(
  "a sibling's assignment allows its own strokes per assignment",
  sibAssignment.json?.assignment_strokes_remaining === 250,
  sibAssignment.json,
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
const cell = series.table?.find((c: Json) => c.strokes_per_assignment === 3);
check(
  "results include the final score and think time",
  typeof cell?.final_score === "number" && typeof cell?.mean_think_ms === "number",
  cell,
);

// Painting ids are public: a stranger sending bad keys gets limited, without
// using up the painting's own allowance.
const target = await create({ style: "landscape", size: "study", max_strokes: 5, strokes_per_assignment: 5 });
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
const keyHolder = await connect(new URL(target.body.mcp_url), undefined, {
  "CF-Connecting-IP": "192.0.2.77",
});
const ownerAssignment = await scopedCall(keyHolder, "get_assignment");
check("the agent key still works for its own client", !!ownerAssignment.json?.token, ownerAssignment.json);
await keyHolder.close();

// --- Owner delete -------------------------------------------------------------------

const kept = await create({ style: "landscape", reference: "krita-sunset", size: "study", max_strokes: 5 });
const doomed = await create({
  style: "landscape",
  reference: "krita-sunset",
  size: "study",
  max_strokes: 5,
  series: kept.body.series_id,
  series_key: kept.body.series_key,
});
for (const made of [kept.body, doomed.body]) {
  const c = await connect(new URL(made.mcp_url));
  const a = (await scopedCall(c, "get_assignment")).json;
  await scopedCall(c, "submit_stroke", { token: a.token, stroke_data: studyStroke(20, 40) });
  await c.close();
}
const ownerCall = (id: string, key: string, method: string, path = "") =>
  fetch(`${base}/api/paintings/${id}${path}`, { method, headers: { Authorization: `Bearer ${key}` } });
const beforeDelete = (await (
  await ownerCall(doomed.body.id, doomed.body.owner_key, "POST", "/verify")
).json()) as Json;
check(
  "the painting to delete has a stored snapshot of its stroke",
  beforeDelete.version === 1 && beforeDelete.fromScratch === true,
  beforeDelete,
);
const wrongDelete = await ownerCall(doomed.body.id, "C".repeat(32), "DELETE");
check("delete with a wrong key is unauthorized", wrongDelete.status === 401, wrongDelete.status);
const agentDelete = await ownerCall(doomed.body.id, doomed.body.agent_key, "DELETE");
check("delete with the agent key is unauthorized", agentDelete.status === 401, agentDelete.status);
const ownerDelete = await ownerCall(doomed.body.id, doomed.body.owner_key, "DELETE");
check("the owner key deletes the painting", ownerDelete.status === 200, ownerDelete.status);
const gone = await Promise.all(
  ["", "/strokes", "/v/0", "/v/1", "/reference"].map(
    async (path) => [path, (await fetch(`${base}/api/paintings/${doomed.body.id}${path}`)).status] as const,
  ),
);
check(
  "a deleted painting's summary, strokes, snapshots and reference are 404",
  gone.every(([, status]) => status === 404),
  gone,
);
const deletedMcp = await fetch(doomed.body.mcp_url, { method: "POST", body: "{}" });
check("a deleted painting's MCP endpoint is unauthorized", deletedMcp.status === 401, deletedMcp.status);
const deleteAgain = await ownerCall(doomed.body.id, doomed.body.owner_key, "DELETE");
check("deleting it again is unauthorized", deleteAgain.status === 401, deleteAgain.status);
const keptSeries = (await (await fetch(`${base}/api/series/${kept.body.series_id}`)).json()) as Json;
check(
  "the series lists only the painting that was kept",
  JSON.stringify(keptSeries.paintings?.map((x: Json) => x.id)) === JSON.stringify([kept.body.id]),
  keptSeries.paintings?.map((x: Json) => x.id),
);
const keptTests = (await (
  await fetch(`${base}/api/tests/krita-sunset?series=${kept.body.series_id}`)
).json()) as Json;
check(
  "the reference test lists only the painting that was kept",
  JSON.stringify(keptTests.paintings?.map((x: Json) => x.id)) === JSON.stringify([kept.body.id]),
  keptTests.paintings?.map((x: Json) => x.id),
);

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
