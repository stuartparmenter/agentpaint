// Painting on the pooled endpoint (/mcp): workers paint one stroke per session
// on whatever painting the pool assigns.

import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { type Client, SdkHttpError } from "@modelcontextprotocol/client";
import { type Effort, paramsFor } from "./capabilities";
import { connect, type McpContent, toToolContent } from "./paint";
import { POOL_SYSTEM_PROMPT, POOL_TURN } from "./prompt";
import { randomStroke } from "./random";

export interface PoolOptions {
  mcpUrl: URL;
  bearer: string;
  strokes: number;
  workers: number;
  random: boolean;
  model: string;
  effort: Effort;
  thinkingBudget: number;
}

type Outcome = "applied" | "busy" | "failed";

export async function runPool(anthropic: Anthropic | null, opts: PoolOptions) {
  let remaining = opts.strokes;
  let painted = 0;
  const usage = { input: 0, output: 0 };

  async function claudeStroke(tag: string, mcp: Client): Promise<Outcome> {
    if (!anthropic) throw new Error("painting with Claude needs an Anthropic client");
    const params = await paramsFor(anthropic, opts.model, opts.effort, opts.thinkingBudget);
    const { tools: mcpTools } = await mcp.listTools();
    let outcome: Outcome = "failed";
    const tools = mcpTools.map((tool) => {
      const { $schema: _dialect, ...schema } = tool.inputSchema as Record<string, unknown>;
      return betaTool({
        name: tool.name,
        description: tool.description ?? tool.name,
        inputSchema: schema as { type: "object" },
        run: async (input) => {
          const result = await mcp.callTool({ name: tool.name, arguments: input as Record<string, unknown> });
          const content = result.content as McpContent[];
          const parsed = JSON.parse(content.find((c) => c.type === "text")?.text ?? "{}");
          if (tool.name === "get_assignment" && outcome !== "applied") {
            outcome = parsed.available === false ? "busy" : "failed";
          }
          if (tool.name === "submit_stroke") {
            if (parsed.applied) outcome = "applied";
            console.log(
              `${tag} submit_stroke: ${parsed.applied ? `applied (${parsed.stroke_count}/${parsed.max_strokes})` : `rejected: ${parsed.reason}${parsed.detail ? ` (${parsed.detail})` : ""}`}`,
            );
          }
          return toToolContent(content);
        },
      });
    });
    const runner = anthropic.beta.messages.toolRunner({
      model: params.model,
      max_tokens: params.max_tokens,
      ...(params.output_config ? { output_config: params.output_config } : {}),
      ...(params.thinking ? { thinking: params.thinking } : {}),
      max_iterations: 8,
      system: POOL_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
      thread: false,
      tools,
      messages: [{ role: "user", content: POOL_TURN }],
    });
    for await (const message of runner) {
      usage.input += message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0);
      usage.output += message.usage.output_tokens;
      if (message.stop_reason === "refusal") {
        console.warn(`${tag} ${message.model} declined: ${message.stop_details?.category ?? "no category"}`);
        return "failed";
      }
    }
    return outcome;
  }

  async function randomPoolStroke(tag: string, mcp: Client): Promise<Outcome> {
    const assignment = await mcp.callTool({ name: "get_assignment", arguments: {} });
    const meta = JSON.parse(
      (assignment.content as McpContent[]).find((c) => c.type === "text")?.text ?? "{}",
    );
    if (meta.available === false) return "busy";
    const { note: _note, ...stroke_data } = randomStroke(meta);
    const result = await mcp.callTool({
      name: "submit_stroke",
      arguments: { token: meta.token, stroke_data },
    });
    const parsed = JSON.parse((result.content as McpContent[]).find((c) => c.type === "text")?.text ?? "{}");
    console.log(
      `${tag} ${meta.style} ${meta.stroke_count + 1}/${meta.max_strokes} (${meta.phase}): ${parsed.applied ? "applied" : `rejected: ${parsed.reason}`}`,
    );
    return parsed.applied ? "applied" : "failed";
  }

  async function worker(index: number) {
    const tag = `[painter ${index + 1}]`;
    const mcp = await connect(opts.mcpUrl, opts.bearer);
    let consecutiveFailures = 0;
    try {
      while (remaining > 0) {
        if (consecutiveFailures >= 5) {
          console.error(`${tag} giving up after ${consecutiveFailures} failed attempts in a row`);
          return;
        }
        remaining--;
        let outcome: Outcome;
        try {
          outcome = opts.random ? await randomPoolStroke(tag, mcp) : await claudeStroke(tag, mcp);
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
        remaining++; // this attempt didn't paint; the stroke goes back to the budget
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

  await Promise.all(Array.from({ length: opts.workers }, (_, i) => worker(i)));
  return { painted, usage };
}
