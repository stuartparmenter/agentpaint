// Painting one created painting through its scoped MCP URL, with Claude or with
// random strokes.

import type Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import type {
  BetaMessage,
  BetaToolResultContentBlockParam,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta";
import type { Client } from "@modelcontextprotocol/client";
import { MAX_BATCH } from "../../../apps/worker/src/config";
import { type Effort, type ModelParams, paramsFor, requestFields } from "./capabilities";
import { callTool, connect, firstJson, type Json, type McpContent } from "./mcp";
import { LOOK_TURN, PROMPT_HASH, SYSTEM_PROMPT } from "./prompt";
import { type LookMeta, randomStroke } from "./random";

/** Fields the painter fills in itself; hidden from the model's view of submit_stroke. */
const SELF_REPORTED = ["model", "effort", "input_tokens", "output_tokens", "prompt_hash"];

export interface PaintOptions {
  mcpUrl: URL;
  /** Bearer token, for a URL without the key in its path. */
  bearer?: string;
  random: boolean;
  model: string;
  effort: Effort;
  thinkingBudget: number;
  /** Stop after this many looks (a safety cap; the painting's budget normally ends the run). */
  maxLooks: number;
  log: (line: string) => void;
}

export interface PaintSummary {
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

export function toToolContent(content: McpContent[]): BetaToolResultContentBlockParam[] {
  return content.flatMap((c): BetaToolResultContentBlockParam[] => {
    if (c.type === "text" && c.text !== undefined) return [{ type: "text", text: c.text }];
    if (c.type === "image" && c.data && (c.mimeType === "image/png" || c.mimeType === "image/jpeg")) {
      return [{ type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } }];
    }
    return [];
  });
}

export type McpTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

/**
 * The MCP tools as Claude tools, each run by `run`. The model sees each schema
 * without its `$schema` dialect marker and without the properties `hidden` lists
 * for that tool.
 */
export function claudeTools(
  mcpTools: McpTool[],
  run: (name: string, input: Record<string, unknown>) => Promise<BetaToolResultContentBlockParam[]>,
  hidden: Record<string, string[]> = {},
) {
  return mcpTools.map((tool) => {
    const { $schema: _dialect, ...schema } = tool.inputSchema as Json;
    const hide = hidden[tool.name];
    if (hide) {
      schema.properties = Object.fromEntries(
        Object.entries(schema.properties ?? {}).filter(([key]) => !hide.includes(key)),
      );
    }
    return betaTool({
      name: tool.name,
      description: tool.description ?? tool.name,
      inputSchema: schema as { type: "object" },
      run: (input) => run(tool.name, input as Record<string, unknown>),
    });
  });
}

/** Input tokens of one response, counting cache reads and cache writes. */
export function inputTokens(usage: BetaUsage): number {
  return usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

/** Live state of the painting, from the tool results the painter sees. */
class Tracker {
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
    const input = inputTokens(message.usage);
    this.inputTokens += input;
    this.outputTokens += message.usage.output_tokens;
    this.pendingIn += input;
    this.pendingOut += message.usage.output_tokens;
    this.lastModel = message.model;
    this.models.add(message.model);
  }

  noteAssignment(meta: Json) {
    if (meta.available === false) this.status = meta.status ?? "done";
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
      const strokes = Array.from({ length: n }, () => randomStroke(meta as LookMeta));
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
  const run = async (name: string, input: Record<string, unknown>) => {
    const args = { ...input };
    if (name === "submit_stroke") {
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
    const result = await callTool(mcp, name, args, opts.log);
    const content = result.content as McpContent[];
    const json = firstJson(content);
    if (name === "get_assignment") {
      t.noteAssignment(json);
      opts.log(
        json.available === false
          ? `get_assignment: painting ${json.status}`
          : `get_assignment: look ${json.look}${json.new_look ? "" : " (still open)"}, ${json.strokes_remaining} stroke(s) allowed, ${json.stroke_count}/${json.max_strokes} painted`,
      );
    } else if (name === "submit_stroke") {
      t.noteSubmit(json);
      opts.log(
        json.applied
          ? `submit_stroke: ${json.applied_count} applied (${json.stroke_count}/${json.max_strokes}, ${json.strokes_remaining} left on the look)${json.status === "done" ? ", painting done" : ""}`
          : `submit_stroke: rejected ${json.reason}${json.index !== undefined ? ` at ${json.index}` : ""}${json.detail ? ` (${json.detail})` : ""}`,
      );
    }
    return toToolContent(content);
  };
  const { tools: mcpTools } = await mcp.listTools();
  const tools = claudeTools(mcpTools, run, { submit_stroke: SELF_REPORTED });

  const base = {
    ...requestFields(params),
    system: SYSTEM_PROMPT,
    cache_control: { type: "ephemeral" as const },
    tools,
    // Most API calls the tool runner makes for one look.
    max_iterations: 40,
    // Plain Messages API behavior on every model generation.
    thread: false as const,
  };

  /** Run one look as a new conversation; returns a stop reason, or null to go on. */
  const look = async (): Promise<string | null> => {
    const runner = anthropic.beta.messages.toolRunner({
      ...base,
      messages: [{ role: "user", content: LOOK_TURN }],
    });
    let last: BetaMessage | null = null;
    for await (const message of runner) {
      t.noteMessage(message);
      last = message;
      if (message.stop_reason === "refusal") return `refusal: ${message.stop_details?.category ?? "unknown"}`;
      if (message.stop_reason === "max_tokens") opts.log("reply hit max_tokens");
    }
    const note = last?.content.find((b) => b.type === "text");
    if (note?.type === "text") opts.log(`model: ${note.text.trim().split("\n")[0]}`);
    return null;
  };

  // Every look is a new conversation, so the canvas is all a look carries over.
  let idle = 0;
  while (t.active) {
    if (t.looks >= opts.maxLooks) return "max looks reached";
    const before = t.strokes;
    const stop = await look();
    if (stop) return stop;
    if (!t.active) break;
    idle = t.strokes === before ? idle + 1 : 0;
    if (idle >= 3) return "no strokes in 3 conversations";
  }
  return t.status;
}
