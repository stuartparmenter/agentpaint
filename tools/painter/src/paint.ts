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
import { type Prompts, promptsFor } from "./prompt";
import { type AssignmentMeta, randomStroke } from "./random";

/** Fields the painter fills in itself; hidden from the model's view of submit_stroke. */
const SELF_REPORTED = ["model", "effort", "input_tokens", "output_tokens", "prompt_hash"];

export interface PaintOptions {
  mcpUrl: URL;
  /** Bearer token, for a URL without the key in its path. */
  bearer?: string;
  random: boolean;
  /** Whether the painting lets the agent end it early; picks the prompts. */
  allowFinish: boolean;
  model: string;
  /** Null sends no effort, so the model runs at its default. */
  effort: Effort | null;
  thinkingBudget: number;
  /** Stop after this many assignments (a safety cap; the painting's budget normally ends the run). */
  maxAssignments: number;
  /** Receives each assignment's thinking summaries, where the model returns them. */
  onThinking?: (entry: ThinkingEntry) => void;
  log: (line: string) => void;
}

/** The thinking summaries from one assignment's conversation. */
export interface ThinkingEntry {
  assignment: number;
  strokesBefore: number;
  strokesAfter: number;
  /** The painting ended during this assignment. */
  ended: boolean;
  thinking: string[];
}

export interface PaintSummary {
  status: string;
  strokes: number;
  assignments: number;
  inputTokens: number;
  outputTokens: number;
  /** Models named in the API responses. */
  models: string[];
  sent: ModelParams["sent"] | null;
  stopReason: string;
}

function toToolContent(content: McpContent[]): BetaToolResultContentBlockParam[] {
  return content.flatMap((c): BetaToolResultContentBlockParam[] => {
    if (c.type === "text" && c.text !== undefined) return [{ type: "text", text: c.text }];
    if (c.type === "image" && c.data && (c.mimeType === "image/png" || c.mimeType === "image/jpeg")) {
      return [{ type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } }];
    }
    return [];
  });
}

type McpTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

/**
 * The MCP tools as Claude tools, each run by `run`. The model sees each schema
 * without its `$schema` dialect marker and without the properties `hidden` lists
 * for that tool.
 */
function claudeTools(
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
function inputTokens(usage: BetaUsage): number {
  return usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

/** Live state of the painting, from the tool results the painter sees. */
class Tracker {
  status = "active";
  strokes = 0;
  assignments = 0;
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
    if (meta.new_assignment) this.assignments += 1;
  }

  noteSubmit(result: Json) {
    if (typeof result.stroke_count === "number") this.strokes = result.stroke_count;
    if (typeof result.status === "string") this.status = result.status;
  }
}

export async function paintScoped(anthropic: Anthropic | null, opts: PaintOptions): Promise<PaintSummary> {
  const mcp = await connect(opts.mcpUrl, opts.bearer);
  const t = new Tracker();
  const prompts = promptsFor(opts.allowFinish);
  let sent: ModelParams["sent"] | null = null;
  let stopReason = "finished";
  try {
    if (opts.random) {
      stopReason = await paintRandom(mcp, t, prompts, opts);
    } else {
      if (!anthropic) throw new Error("painting with Claude needs an Anthropic client");
      const params = await paramsFor(anthropic, opts.model, opts.effort, opts.thinkingBudget);
      sent = params.sent;
      opts.log(
        `sending: max_tokens ${params.max_tokens}, effort ${sent.effort ?? "default (not sent)"}, thinking ${sent.thinking}`,
      );
      stopReason = await paintWithClaude(anthropic, mcp, t, params, prompts, opts);
    }
  } finally {
    await mcp.close();
  }
  return {
    status: t.status,
    strokes: t.strokes,
    assignments: t.assignments,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    models: [...t.models],
    sent,
    stopReason,
  };
}

async function paintRandom(mcp: Client, t: Tracker, prompts: Prompts, opts: PaintOptions): Promise<string> {
  while (t.active) {
    if (t.assignments >= opts.maxAssignments) return "max assignments reached";
    const assignment = await callTool(mcp, "get_assignment", {}, opts.log);
    const meta = firstJson(assignment.content as McpContent[]);
    t.noteAssignment(meta);
    if (!t.active || typeof meta.token !== "string") break;
    let remaining: number = meta.assignment_strokes_remaining ?? 1;
    while (remaining > 0 && t.active) {
      const n = Math.min(remaining, MAX_BATCH);
      const strokes = Array.from({ length: n }, () => randomStroke(meta as AssignmentMeta));
      const res = await callTool(
        mcp,
        "submit_stroke",
        { token: meta.token, strokes, model: "random", prompt_hash: prompts.hash },
        opts.log,
      );
      const result = firstJson(res.content as McpContent[]);
      t.noteSubmit(result);
      if (!result.applied) return `rejected: ${result.reason}`;
      remaining = result.assignment_strokes_remaining ?? 0;
    }
    opts.log(`assignment ${t.assignments}: ${t.strokes} strokes`);
  }
  return t.status;
}

async function paintWithClaude(
  anthropic: Anthropic,
  mcp: Client,
  t: Tracker,
  params: ModelParams,
  prompts: Prompts,
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
        prompt_hash: prompts.hash,
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
          : `get_assignment: assignment ${json.assignment}${json.new_assignment ? "" : " (still open)"}, ${json.assignment_strokes_remaining} stroke(s) allowed, ${json.stroke_count}/${json.max_strokes} painted`,
      );
    } else if (name === "submit_stroke") {
      t.noteSubmit(json);
      opts.log(
        json.applied
          ? `submit_stroke: ${json.applied_count} applied (${json.stroke_count}/${json.max_strokes}, ${json.assignment_strokes_remaining} left on the assignment)${args.finished ? ", finished: true" : ""}${json.status === "done" ? ", painting done" : ""}`
          : json.reason === undefined
            ? `submit_stroke: rejected (${content.find((c) => c.type === "text")?.text?.slice(0, 200) ?? "no text"})`
            : `submit_stroke: rejected ${json.reason}${json.index !== undefined ? ` at ${json.index}` : ""}${json.detail ? ` (${json.detail})` : ""}`,
      );
    }
    return toToolContent(content);
  };
  const { tools: mcpTools } = await mcp.listTools();
  const tools = claudeTools(mcpTools, run, { submit_stroke: SELF_REPORTED });

  const base = {
    ...requestFields(params),
    system: prompts.system,
    cache_control: { type: "ephemeral" as const },
    tools,
    // Most API calls the tool runner makes for one assignment.
    max_iterations: 40,
    // Replies are streamed: the SDK refuses unstreamed requests with a large max_tokens.
    stream: true as const,
    // Plain Messages API behavior on every model generation.
    thread: false as const,
  };

  /** Run one assignment as a new conversation; returns a stop reason, or null to go on. */
  const runAssignment = async (): Promise<string | null> => {
    const runner = anthropic.beta.messages.toolRunner({
      ...base,
      messages: [{ role: "user", content: prompts.turn }],
    });
    let last: BetaMessage | null = null;
    const before = t.strokes;
    const thinking: string[] = [];
    // Leaving this loop early (a return or an exception) closes the runner, which
    // aborts the reply it is streaming.
    for await (const stream of runner) {
      try {
        const message = await stream.finalMessage();
        t.noteMessage(message);
        last = message;
        for (const block of message.content) {
          if (block.type === "thinking" && block.thinking.trim()) thinking.push(block.thinking.trim());
        }
        if (message.stop_reason === "refusal")
          return `refusal: ${message.stop_details?.category ?? "unknown"}`;
        if (message.stop_reason === "max_tokens") opts.log("reply hit max_tokens");
      } finally {
        // Ends a reply that wasn't read to the end; a finished one is unaffected.
        stream.abort();
      }
    }
    if (thinking.length) {
      opts.log(`thinking: ${thinking[0]?.split("\n")[0]?.slice(0, 200)}`);
      opts.onThinking?.({
        assignment: t.assignments,
        strokesBefore: before,
        strokesAfter: t.strokes,
        ended: !t.active,
        thinking,
      });
    }
    const note = last?.content.find((b) => b.type === "text");
    if (note?.type === "text") opts.log(`model: ${note.text.trim().split("\n")[0]}`);
    return null;
  };

  // Every assignment is a new conversation, so the canvas is all an assignment carries over.
  let idle = 0;
  while (t.active) {
    if (t.assignments >= opts.maxAssignments) return "max assignments reached";
    const before = t.strokes;
    const stop = await runAssignment();
    if (stop) return stop;
    if (!t.active) break;
    idle = t.strokes === before ? idle + 1 : 0;
    if (idle >= 3) return "no strokes in 3 conversations";
  }
  return t.status;
}
