#!/usr/bin/env bun
// AgentPaint painter.
//
// A painting's own MCP URL (/mcp/p/<id>/<key>) paints that painting until it is
// finished:
//   bun src/index.ts --url https://…/mcp/p/<id>/<key> [--model ID] [--effort LEVEL]
//
// The pooled endpoint (/mcp, with AGENTPAINT_TOKEN) paints single strokes on
// whatever paintings the pool assigns:
//   bun src/index.ts --url https://…/mcp --strokes 20 --workers 2
//
// --random paints random strokes without calling Claude. Anthropic credentials
// come from ANTHROPIC_API_KEY or an `ant auth login` profile.

import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { EFFORTS, type Effort } from "./capabilities";
import { fail, positiveInt } from "./cli";
import { paintScoped } from "./paint";
import { runPool } from "./pool";
import { PROMPT_HASH } from "./prompt";
import { thinkingLog } from "./thinking-log";

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    "thinking-budget": { type: "string", default: "8000" },
    "max-assignments": { type: "string", default: "2000" },
    strokes: { type: "string", default: "10" },
    workers: { type: "string", default: "1" },
    random: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (args.help) {
  console.log(`Usage: agentpaint-painter --url MCP_URL [options]

  --url              a painting's MCP URL (/mcp/p/<id>/<key>), or the pooled /mcp endpoint
                     (default $AGENTPAINT_MCP_URL or http://127.0.0.1:8787/mcp)
  --model            Claude model (default $PAINTER_MODEL or claude-opus-5-5)
  --effort           ${EFFORTS.join(" | ")}, sent only to models that support it (default $PAINTER_EFFORT;
                     without either, no effort is sent and each model runs at its own default)
  --thinking-budget  extended-thinking tokens for models without adaptive thinking (default 8000)
  --max-assignments  stop a painting after this many assignments (default 2000)
  --random           random strokes, no Claude
  Pooled endpoint only (with AGENTPAINT_TOKEN):
  --strokes          total strokes across all workers (default 10)
  --workers          concurrent painters (default 1)`);
  process.exit(0);
}

const url = new URL(args.url ?? process.env.AGENTPAINT_MCP_URL ?? "http://127.0.0.1:8787/mcp");
const model = args.model ?? process.env.PAINTER_MODEL ?? "claude-opus-5-5";
const effort = (args.effort ?? process.env.PAINTER_EFFORT ?? null) as Effort | null;
if (effort !== null && !EFFORTS.includes(effort)) fail(`--effort must be one of ${EFFORTS.join(", ")}`);
const effortLabel = effort ?? "default";
const thinkingBudget = positiveInt(args["thinking-budget"], "--thinking-budget");

const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
  fail(
    `Refusing to send credentials over ${url.protocol} to ${url.host}; use https (http only for localhost)`,
  );
}

const anthropic = args.random ? null : new Anthropic();
const scoped = /^\/mcp\/p\/[0-9A-Za-z]{12}(\/[0-9A-Za-z]{32})?$/.test(url.pathname);

if (scoped) {
  const withKey = /\/[0-9A-Za-z]{32}$/.test(url.pathname);
  const bearer = withKey ? undefined : process.env.AGENTPAINT_TOKEN;
  if (!withKey && !bearer)
    fail("this URL has no key in its path; set AGENTPAINT_TOKEN to the painting's agent key");
  console.log(
    `Painting ${url.pathname.split("/")[3]}: ${args.random ? "random strokes" : `${model}, effort ${effortLabel}, a new conversation per assignment`}, prompts ${PROMPT_HASH}`,
  );
  const thoughts = thinkingLog(url.pathname.split("/")[3] as string);
  const summary = await paintScoped(anthropic, {
    mcpUrl: url,
    bearer,
    random: args.random,
    model,
    effort,
    thinkingBudget,
    maxAssignments: positiveInt(args["max-assignments"], "--max-assignments"),
    log: (line) => console.log(line),
    onThinking: thoughts.write,
  });
  if (!args.random) console.log(`Thinking summaries: ${thoughts.path}`);
  console.log(
    `Done (${summary.stopReason}): ${summary.strokes} strokes over ${summary.assignments} assignments, status ${summary.status}. ` +
      `Models: ${summary.models.join(", ") || "none"}. Sent: ${summary.sent ? `effort ${summary.sent.effort ?? "default (not sent)"}, thinking ${summary.sent.thinking}` : "n/a"}. ` +
      `Tokens: ${summary.inputTokens} in, ${summary.outputTokens} out.`,
  );
} else {
  const bearer = process.env.AGENTPAINT_TOKEN;
  if (!bearer) fail("the pooled endpoint needs AGENTPAINT_TOKEN (a token from the server's MCP_TOKENS)");
  const strokes = positiveInt(args.strokes, "--strokes");
  const workers = positiveInt(args.workers, "--workers");
  console.log(
    `Painting ${strokes} pool stroke(s) with ${workers} worker(s): ${args.random ? "random strokes" : `${model}, effort ${effortLabel}`}, ${url.href}`,
  );
  const { painted, usage } = await runPool(anthropic, {
    mcpUrl: url,
    bearer,
    strokes,
    workers,
    random: args.random,
    model,
    effort,
    thinkingBudget,
  });
  console.log(`Done: ${painted} stroke(s). Tokens: ${usage.input} in, ${usage.output} out.`);
}
