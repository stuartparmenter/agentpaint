// Painting on the pooled endpoint (/mcp): workers paint one stroke per session
// on whatever painting the pool assigns.

import Anthropic from "@anthropic-ai/sdk";
import type { Client } from "@modelcontextprotocol/client";
import { type Effort, paramsFor, requestFields } from "./capabilities";
import { callTool, connect, firstJson, type McpContent } from "./mcp";
import { claudeTools, inputTokens, type McpTool, toToolContent } from "./paint";
import { POOL_SYSTEM_PROMPT, POOL_TURN } from "./prompt";
import { type AssignmentMeta, randomStroke } from "./random";

export interface PoolOptions {
  mcpUrl: URL;
  bearer: string;
  strokes: number;
  workers: number;
  random: boolean;
  model: string;
  /** Null sends no effort, so the model runs at its default. */
  effort: Effort | null;
  thinkingBudget: number;
}

type Outcome = "applied" | "busy" | "failed";

export async function runPool(anthropic: Anthropic | null, opts: PoolOptions) {
  let remaining = opts.strokes;
  let painted = 0;
  const usage = { input: 0, output: 0 };

  async function claudeStroke(tag: string, mcp: Client, mcpTools: McpTool[]): Promise<Outcome> {
    if (!anthropic) throw new Error("painting with Claude needs an Anthropic client");
    const params = await paramsFor(anthropic, opts.model, opts.effort, opts.thinkingBudget);
    let outcome: Outcome = "failed";
    const tools = claudeTools(mcpTools, async (name, input) => {
      const result = await callTool(mcp, name, input, (l) => console.warn(`${tag} ${l}`));
      const content = result.content as McpContent[];
      const parsed = firstJson(content);
      if (name === "get_assignment" && outcome !== "applied") {
        outcome = parsed.available === false ? "busy" : "failed";
      }
      if (name === "submit_stroke") {
        if (parsed.applied) outcome = "applied";
        console.log(
          `${tag} submit_stroke: ${parsed.applied ? `applied (${parsed.stroke_count}/${parsed.max_strokes})` : `rejected: ${parsed.reason}${parsed.detail ? ` (${parsed.detail})` : ""}`}`,
        );
      }
      return toToolContent(content);
    });
    const runner = anthropic.beta.messages.toolRunner({
      ...requestFields(params),
      max_iterations: 8,
      system: POOL_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
      thread: false,
      tools,
      messages: [{ role: "user", content: POOL_TURN }],
    });
    for await (const message of runner) {
      usage.input += inputTokens(message.usage);
      usage.output += message.usage.output_tokens;
      if (message.stop_reason === "refusal") {
        console.warn(`${tag} ${message.model} declined: ${message.stop_details?.category ?? "no category"}`);
        return "failed";
      }
    }
    return outcome;
  }

  async function randomPoolStroke(tag: string, mcp: Client): Promise<Outcome> {
    const log = (l: string) => console.warn(`${tag} ${l}`);
    const assignment = await callTool(mcp, "get_assignment", {}, log);
    const meta = firstJson(assignment.content as McpContent[]);
    if (meta.available === false) return "busy";
    const { note: _note, ...stroke_data } = randomStroke(meta as AssignmentMeta);
    const result = await callTool(mcp, "submit_stroke", { token: meta.token, stroke_data }, log);
    const parsed = firstJson(result.content as McpContent[]);
    console.log(
      `${tag} ${meta.style} ${meta.stroke_count + 1}/${meta.max_strokes}: ${parsed.applied ? "applied" : `rejected: ${parsed.reason}`}`,
    );
    return parsed.applied ? "applied" : "failed";
  }

  async function worker(index: number) {
    const tag = `[painter ${index + 1}]`;
    const mcp = await connect(opts.mcpUrl, opts.bearer);
    let consecutiveFailures = 0;
    try {
      const mcpTools = opts.random ? [] : (await mcp.listTools()).tools;
      while (remaining > 0) {
        if (consecutiveFailures >= 5) {
          console.error(`${tag} giving up after ${consecutiveFailures} failed attempts in a row`);
          return;
        }
        remaining--;
        let outcome: Outcome;
        try {
          outcome = opts.random ? await randomPoolStroke(tag, mcp) : await claudeStroke(tag, mcp, mcpTools);
        } catch (e) {
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
