#!/usr/bin/env bun
// AgentPaint painter: Claude agents that connect to the AgentPaint MCP server
// and paint one stroke per session.
//
//   bun src/index.ts --strokes 20 --workers 2
//
// Environment:
//   AGENTPAINT_MCP_URL   MCP endpoint (default http://127.0.0.1:8787/mcp)
//   AGENTPAINT_TOKEN     bearer token for the MCP endpoint (required)
//   PAINTER_MODEL        Claude model (default claude-opus-5-5)
//   PAINTER_EFFORT       low | medium | high | xhigh | max (default medium)
//   Anthropic credentials: ANTHROPIC_API_KEY, or an `ant auth login` profile.

import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import type { BetaToolResultContentBlockParam } from "@anthropic-ai/sdk/resources/beta";
import { Client, SdkHttpError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SYSTEM_PROMPT, TURN_PROMPT } from "./prompt";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

const { values: args } = parseArgs({
  options: {
    strokes: { type: "string", default: "10" },
    workers: { type: "string", default: "1" },
    model: { type: "string" },
    effort: { type: "string" },
    url: { type: "string" },
    random: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (args.help) {
  console.log(`Usage: agentpaint-painter [--strokes N] [--workers N] [--model ID] [--effort LEVEL] [--url MCP_URL]

  --strokes  total strokes to paint across all workers (default 10)
  --workers  concurrent painters (default 1)
  --model    Claude model (default $PAINTER_MODEL or claude-opus-5-5)
  --effort   ${EFFORTS.join(" | ")} (default $PAINTER_EFFORT or medium)
  --url      MCP endpoint (default $AGENTPAINT_MCP_URL or http://127.0.0.1:8787/mcp)
  --random   paint random strokes without calling Claude (for local testing)`);
  process.exit(0);
}

const strokeBudget = positiveInt(args.strokes, "--strokes");
const workerCount = positiveInt(args.workers, "--workers");
const model = args.model ?? process.env.PAINTER_MODEL ?? "claude-opus-5-5";
const effort = (args.effort ?? process.env.PAINTER_EFFORT ?? "medium") as Effort;
const mcpUrl = new URL(args.url ?? process.env.AGENTPAINT_MCP_URL ?? "http://127.0.0.1:8787/mcp");
const bearer = process.env.AGENTPAINT_TOKEN;

if (!EFFORTS.includes(effort)) fail(`--effort must be one of ${EFFORTS.join(", ")}`);
if (!bearer) fail("AGENTPAINT_TOKEN is required (a token from the server's MCP_TOKENS)");
const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(mcpUrl.hostname);
if (mcpUrl.protocol !== "https:" && !(mcpUrl.protocol === "http:" && loopback)) {
  fail(
    `Refusing to send the token over ${mcpUrl.protocol} to ${mcpUrl.host}; use https (http only for localhost)`,
  );
}

function positiveInt(value: string | undefined, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(`${name} must be a positive integer`);
  return n;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// Only needed (and only requires credentials) when painting with Claude.
const anthropic = args.random ? null : new Anthropic();
const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
let remaining = strokeBudget;
let painted = 0;

type McpContent = { type: string; text?: string; data?: string; mimeType?: string };

/** Convert an MCP tool result into Messages API tool-result content (text and images pass through). */
function toToolContent(content: McpContent[]): BetaToolResultContentBlockParam[] {
  return content.flatMap((c): BetaToolResultContentBlockParam[] => {
    if (c.type === "text" && c.text !== undefined) return [{ type: "text", text: c.text }];
    if (c.type === "image" && c.data && (c.mimeType === "image/png" || c.mimeType === "image/jpeg")) {
      return [{ type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } }];
    }
    return [];
  });
}

async function connect(): Promise<Client> {
  const client = new Client({ name: "agentpaint-painter", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    }),
  );
  return client;
}

async function paintOneStroke(tag: string, mcp: Client): Promise<"applied" | "busy" | "failed"> {
  const { tools: mcpTools } = await mcp.listTools();
  let outcome: "applied" | "busy" | "failed" = "failed";

  const tools = mcpTools.map((tool) =>
    betaTool({
      name: tool.name,
      description: tool.description ?? tool.name,
      // Pass the JSON Schema through without the `$schema` dialect marker.
      inputSchema: (({ $schema: _dialect, ...schema }) => schema)(tool.inputSchema) as { type: "object" },
      run: async (input) => {
        const result = await mcp.callTool({ name: tool.name, arguments: input as Record<string, unknown> });
        const content = result.content as McpContent[];
        const text = content.find((c) => c.type === "text")?.text ?? "";
        if (tool.name === "get_assignment" && outcome !== "applied") {
          // Reflect the latest assignment attempt: busy, or a canvas to paint.
          outcome = text.includes('"available":false') ? "busy" : "failed";
        }
        if (tool.name === "submit_stroke") {
          const parsed = JSON.parse(text || "{}");
          if (parsed.applied) outcome = "applied";
          console.log(
            `${tag} submit_stroke: ${parsed.applied ? `applied (${parsed.stroke_count}/${parsed.max_strokes})` : `rejected: ${parsed.reason}${parsed.detail ? ` — ${parsed.detail}` : ""}`}`,
          );
        } else if (tool.name === "get_assignment" && outcome !== "busy") {
          const meta = JSON.parse(text || "{}");
          console.log(
            `${tag} get_assignment: ${meta.style} "${meta.prompt ?? "open subject"}", stroke ${meta.stroke_count}/${meta.max_strokes}, phase ${meta.phase}`,
          );
        }
        return toToolContent(content);
      },
    }),
  );

  if (!anthropic) throw new Error("Claude painting needs an Anthropic client");
  const runner = anthropic.beta.messages.toolRunner({
    model,
    max_tokens: 16000,
    max_iterations: 8,
    system: SYSTEM_PROMPT,
    cache_control: { type: "ephemeral" },
    output_config: { effort },
    // Retry a policy decline on a fallback model chosen by the API.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    tools,
    messages: [{ role: "user", content: TURN_PROMPT }],
  });

  for await (const message of runner) {
    usage.input += message.usage.input_tokens;
    usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;
    usage.output += message.usage.output_tokens;
    if (message.stop_reason === "refusal") {
      console.warn(`${tag} model declined: ${message.stop_details?.explanation ?? "no details"}`);
      return "failed";
    }
    if (message.stop_reason === "max_tokens") console.warn(`${tag} reply hit max_tokens`);
    if (message.stop_reason === "end_turn") {
      const note = message.content.find((b) => b.type === "text");
      if (note && note.type === "text") console.log(`${tag} ${note.text.trim().split("\n")[0]}`);
    }
  }
  return outcome;
}

/** One random stroke that respects the phase's minimum brush size (no Claude involved). */
async function paintRandomStroke(tag: string, mcp: Client): Promise<"applied" | "busy" | "failed"> {
  const assignment = await mcp.callTool({ name: "get_assignment", arguments: {} });
  const content = toToolContent(assignment.content as McpContent[]);
  const meta = JSON.parse(content.find((c) => c.type === "text")?.text ?? "{}");
  if (meta.available === false) return "busy";
  if (!content.some((c) => c.type === "image")) return "failed";

  const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
  const minSize = Math.min(200, meta.min_brush_size);
  const size = rand(minSize, Math.min(200, Math.max(minSize * 1.6, minSize + 10)));
  let x = rand(0, meta.canvas_width);
  let y = rand(0, meta.canvas_height);
  let angle = rand(0, Math.PI * 2);
  const count = 2 + Math.floor(rand(0, 5));
  const points: { x: number; y: number; pressure: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (i > 0) {
      angle += rand(-0.8, 0.8);
      x = Math.min(meta.canvas_width, Math.max(0, x + Math.cos(angle) * size * 1.5));
      y = Math.min(meta.canvas_height, Math.max(0, y + Math.sin(angle) * size * 1.5));
    }
    const taper = i === 0 || i === count - 1 ? 0.4 : 1;
    points.push({ x, y, pressure: Math.min(1, rand(0.6, 1) * taper + 0.1) });
  }
  const stroke_data = {
    points,
    brush: { size, hardness: rand(0.2, 0.9), opacity: rand(0.5, 1), flow: rand(0.5, 1) },
    color: { r: Math.floor(rand(0, 256)), g: Math.floor(rand(0, 256)), b: Math.floor(rand(0, 256)) },
  };
  const result = await mcp.callTool({ name: "submit_stroke", arguments: { token: meta.token, stroke_data } });
  const text = (result.content as McpContent[]).find((c) => c.type === "text")?.text ?? "{}";
  const parsed = JSON.parse(text);
  console.log(
    `${tag} ${meta.style} ${meta.stroke_count + 1}/${meta.max_strokes} (${meta.phase}): ${parsed.applied ? "applied" : `rejected: ${parsed.reason}`}`,
  );
  return parsed.applied ? "applied" : "failed";
}

async function worker(index: number) {
  const tag = `[painter ${index + 1}]`;
  const mcp = await connect();
  let consecutiveFailures = 0;
  try {
    while (remaining > 0) {
      if (consecutiveFailures >= 5) {
        console.error(`${tag} giving up after ${consecutiveFailures} failed attempts in a row`);
        return;
      }
      remaining--;
      let outcome: Awaited<ReturnType<typeof paintOneStroke>>;
      try {
        outcome = args.random ? await paintRandomStroke(tag, mcp) : await paintOneStroke(tag, mcp);
      } catch (e) {
        if (e instanceof SdkHttpError && e.status === 429) {
          // The AgentPaint server rate-limits per agent token; wait out the window.
          remaining++;
          console.warn(`${tag} AgentPaint rate limit reached; waiting 60s`);
          await Bun.sleep(60_000);
          continue;
        }
        if (e instanceof Anthropic.RateLimitError) console.warn(`${tag} rate limited by the Claude API`);
        else if (e instanceof Anthropic.APIError)
          console.error(`${tag} Claude API error ${e.status}: ${e.message}`);
        else console.error(`${tag} error:`, e);
        outcome = "failed";
      }
      if (outcome === "applied") {
        painted++;
        consecutiveFailures = 0;
        continue;
      }
      remaining++; // this attempt didn't paint; give the stroke back
      if (outcome === "failed") consecutiveFailures++;
      const wait = outcome === "busy" ? 30_000 : 10_000;
      console.log(
        `${tag} ${outcome === "busy" ? "all paintings busy" : "stroke failed"}; retrying in ${wait / 1000}s`,
      );
      await Bun.sleep(wait);
    }
  } finally {
    await mcp.close();
  }
}

console.log(
  `Painting ${strokeBudget} stroke(s) with ${workerCount} worker(s): ${args.random ? "random strokes" : `${model}, effort ${effort}`}, ${mcpUrl.href}`,
);
await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
console.log(
  `Done: ${painted} stroke(s). Tokens: ${usage.input} input, ${usage.cacheRead} cache read, ${usage.cacheWrite} cache write, ${usage.output} output.`,
);
