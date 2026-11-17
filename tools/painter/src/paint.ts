// Painting one created painting through its scoped MCP URL, with Claude or with
// random strokes.

import type Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import type {
  BetaMessage,
  BetaMessageParam,
  BetaToolResultContentBlockParam,
} from "@anthropic-ai/sdk/resources/beta";
import { Client, SdkHttpError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Effort, ModelParams } from "./capabilities";
import { paramsFor } from "./capabilities";
import { CONTINUE_TURN, LOOK_TURN, PAINTING_TURN, PROMPT_HASH, SYSTEM_PROMPT } from "./prompt";
import { randomStroke } from "./random";

// biome-ignore lint/suspicious/noExplicitAny: JSON from tool results and the API is untyped.
type Json = Record<string, any>;

export type McpContent = { type: string; text?: string; data?: string; mimeType?: string };

/** Fields the painter fills in itself; hidden from the model's view of submit_stroke. */
const SELF_REPORTED = ["model", "effort", "input_tokens", "output_tokens", "prompt_hash"];
const MAX_BATCH = 50;

export interface PaintOptions {
  mcpUrl: URL;
  /** Bearer token, for a URL without the key in its path. */
  bearer?: string;
  random: boolean;
  model: string;
  effort: Effort;
  thinkingBudget: number;
  context: "fresh" | "keep";
  /** Stop after this many looks (a safety cap; the painting's budget normally ends the run). */
  maxLooks: number;
  log: (line: string) => void;
}

export interface PaintSummary {
  paintingId: string;
  status: string;
  strokes: number;
  looks: number;
  inputTokens: number;
  outputTokens: number;
  /** Models named in the API responses. */
  models: string[];
  sent: ModelParams["sent"] | null;
  stopReason: string;
}

export async function connect(url: URL, bearer?: string): Promise<Client> {
  const client = new Client({ name: "agentpaint-painter", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} },
    }),
  );
  return client;
}

/** Call a tool, waiting out the server's per-painting rate limit (HTTP 429) and retrying. */
export async function callTool(
  mcp: Client,
  name: string,
  args: Record<string, unknown>,
  log: (l: string) => void,
) {
  for (;;) {
    try {
      return await mcp.callTool({ name, arguments: args });
    } catch (e) {
      if (!(e instanceof SdkHttpError && e.status === 429)) throw e;
      log("rate limit reached; waiting 60s");
      await Bun.sleep(60_000);
    }
  }
}

export function toToolContent(content: McpContent[]): BetaToolResultContentBlockParam[] {
  return content.flatMap((c): BetaToolResultContentBlockParam[] => {
    if (c.type === "text" && c.text !== undefined) return [{ type: "text", text: c.text }];
    if (c.type === "image" && c.data && (c.mimeType === "image/png" || c.mimeType === "image/jpeg")) {
      return [{ type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } }];
    }
    return [];
  });
}

function firstJson(content: McpContent[]): Json {
  const text = content.find((c) => c.type === "text" && c.text?.startsWith("{"))?.text;
  return text ? JSON.parse(text) : {};
}

/** Live state of the painting, from the tool results the painter sees. */
class Tracker {
  paintingId = "";
  status = "active";
  strokes = 0;
  looks = 0;
  inputTokens = 0;
  outputTokens = 0;
  models = new Set<string>();
  /** Usage and model since the last submission, reported with it. */
  pendingIn = 0;
  pendingOut = 0;
  lastModel: string | null = null;

  get active() {
    return this.status === "active";
  }

  noteMessage(message: BetaMessage) {
    const u = message.usage;
    const input = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    this.inputTokens += input;
    this.outputTokens += u.output_tokens;
    this.pendingIn += input;
    this.pendingOut += u.output_tokens;
    this.lastModel = message.model;
    this.models.add(message.model);
  }

  noteAssignment(meta: Json) {
    if (meta.available === false) this.status = meta.status ?? "done";
    if (typeof meta.token === "string") this.paintingId = meta.token.split("-")[0] ?? "";
    if (meta.new_look) this.looks += 1;
  }

  noteSubmit(result: Json) {
    if (typeof result.stroke_count === "number") this.strokes = result.stroke_count;
    if (typeof result.status === "string") this.status = result.status;
  }
}

export async function paintScoped(anthropic: Anthropic | null, opts: PaintOptions): Promise<PaintSummary> {
  const mcp = await connect(opts.mcpUrl, opts.bearer);
  const t = new Tracker();
  let sent: ModelParams["sent"] | null = null;
  let stopReason = "finished";
  try {
    if (opts.random) {
      stopReason = await paintRandom(mcp, t, opts);
    } else {
      if (!anthropic) throw new Error("painting with Claude needs an Anthropic client");
      const params = await paramsFor(anthropic, opts.model, opts.effort, opts.thinkingBudget);
      sent = params.sent;
      opts.log(`sending: effort ${sent.effort ?? "(not sent)"}, thinking ${sent.thinking}`);
      stopReason = await paintWithClaude(anthropic, mcp, t, params, opts);
    }
  } finally {
    await mcp.close();
  }
  return {
    paintingId: t.paintingId,
    status: t.status,
    strokes: t.strokes,
    looks: t.looks,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    models: [...t.models],
    sent,
    stopReason,
  };
}

async function paintRandom(mcp: Client, t: Tracker, opts: PaintOptions): Promise<string> {
  while (t.active) {
    if (t.looks >= opts.maxLooks) return "max looks reached";
    const look = await callTool(mcp, "get_assignment", {}, opts.log);
    const meta = firstJson(look.content as McpContent[]);
    t.noteAssignment(meta);
    if (!t.active || typeof meta.token !== "string") break;
    let remaining: number = meta.strokes_remaining ?? 1;
    while (remaining > 0 && t.active) {
      const n = Math.min(remaining, MAX_BATCH);
      const strokes = Array.from({ length: n }, () => randomStroke(meta as never));
      const res = await callTool(
        mcp,
        "submit_stroke",
        { token: meta.token, strokes, model: "random", prompt_hash: PROMPT_HASH },
        opts.log,
      );
      const result = firstJson(res.content as McpContent[]);
      t.noteSubmit(result);
      if (!result.applied) return `rejected: ${result.reason}`;
      remaining = result.strokes_remaining ?? 0;
    }
    opts.log(`look ${t.looks}: ${t.strokes} strokes`);
  }
  return t.status;
}

async function paintWithClaude(
  anthropic: Anthropic,
  mcp: Client,
  t: Tracker,
  params: ModelParams,
  opts: PaintOptions,
): Promise<string> {
  const { tools: mcpTools } = await mcp.listTools();
  const tools = mcpTools.map((tool) => {
    // The model sees the schema without the self-reported fields, and without the
    // `$schema` dialect marker.
    const { $schema: _dialect, ...schema } = tool.inputSchema as Json;
    if (tool.name === "submit_stroke") {
      schema.properties = Object.fromEntries(
        Object.entries(schema.properties ?? {}).filter(([key]) => !SELF_REPORTED.includes(key)),
      );
    }
    return betaTool({
      name: tool.name,
      description: tool.description ?? tool.name,
      inputSchema: schema as { type: "object" },
      run: async (input) => {
        const args = { ...(input as Record<string, unknown>) };
        if (tool.name === "submit_stroke") {
          Object.assign(args, {
            model: t.lastModel ?? undefined,
            effort: params.sent.effort ?? undefined,
            input_tokens: t.pendingIn,
            output_tokens: t.pendingOut,
            prompt_hash: PROMPT_HASH,
          });
          t.pendingIn = 0;
          t.pendingOut = 0;
        }
        const result = await callTool(mcp, tool.name, args, opts.log);
        const content = result.content as McpContent[];
        const json = firstJson(content);
        if (tool.name === "get_assignment") {
          t.noteAssignment(json);
          opts.log(
            json.available === false
              ? `get_assignment: painting ${json.status}`
              : `get_assignment: look ${json.look}${json.new_look ? "" : " (still open)"}, ${json.strokes_remaining} stroke(s) allowed, ${json.stroke_count}/${json.max_strokes} painted`,
          );
        } else if (tool.name === "submit_stroke") {
          t.noteSubmit(json);
          opts.log(
            json.applied
              ? `submit_stroke: ${json.applied_count} applied (${json.stroke_count}/${json.max_strokes}, ${json.strokes_remaining} left on the look)${json.status === "done" ? ", painting done" : ""}`
              : `submit_stroke: rejected ${json.reason}${json.index !== undefined ? ` at ${json.index}` : ""}${json.detail ? ` (${json.detail})` : ""}`,
          );
        }
        return toToolContent(content);
      },
    });
  });

  const base = {
    model: params.model,
    max_tokens: params.max_tokens,
    ...(params.output_config ? { output_config: params.output_config } : {}),
    ...(params.thinking ? { thinking: params.thinking } : {}),
    system: SYSTEM_PROMPT,
    cache_control: { type: "ephemeral" as const },
    tools,
    // Full history every turn: plain Messages API behavior on every model generation.
    thread: false as const,
  };

  /** Run one conversation; returns its messages, or a stop reason. */
  const converse = async (messages: BetaMessageParam[], maxIterations: number) => {
    const runner = anthropic.beta.messages.toolRunner({ ...base, messages, max_iterations: maxIterations });
    let last: BetaMessage | null = null;
    for await (const message of runner) {
      t.noteMessage(message);
      last = message;
      if (message.stop_reason === "refusal")
        return { stop: `refusal: ${message.stop_details?.category ?? "unknown"}` };
      if (message.stop_reason === "max_tokens") opts.log("reply hit max_tokens");
    }
    const history = [...runner.params.messages];
    if (last && history.at(-1)?.role !== "assistant")
      history.push({ role: "assistant", content: last.content });
    const note = last?.content.find((b) => b.type === "text");
    if (note?.type === "text") opts.log(`model: ${note.text.trim().split("\n")[0]}`);
    return { history };
  };

  let idle = 0;
  if (opts.context === "fresh") {
    while (t.active) {
      if (t.looks >= opts.maxLooks) return "max looks reached";
      const before = t.strokes;
      const r = await converse([{ role: "user", content: LOOK_TURN }], 40);
      if ("stop" in r && r.stop) return r.stop;
      idle = t.strokes === before ? idle + 1 : 0;
      if (idle >= 3) return "no strokes in 3 conversations";
    }
    return t.status;
  }

  let messages: BetaMessageParam[] = [{ role: "user", content: PAINTING_TURN }];
  while (t.active) {
    if (t.looks >= opts.maxLooks) return "max looks reached";
    const before = t.strokes;
    const r = await converse(messages, 5000);
    if ("stop" in r && r.stop) return r.stop;
    if (!t.active || !("history" in r) || !r.history) break;
    idle = t.strokes === before ? idle + 1 : 0;
    if (idle >= 3) return "no strokes in 3 turns";
    messages = [...r.history, { role: "user", content: CONTINUE_TURN }];
  }
  return t.status;
}
