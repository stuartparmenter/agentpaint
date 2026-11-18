#!/usr/bin/env bun
// AgentPaint painter: paints one painting through its MCP URL until it is finished.
//   bun src/index.ts --url https://…/mcp/p/<id>/<key> [--model ID] [--effort LEVEL]
//
// A URL without the key in its path (/mcp/p/<id>) takes the agent key from
// AGENTPAINT_AGENT_KEY, sent as a Bearer token.
//
// --random paints random strokes without calling Claude. Anthropic credentials
// come from ANTHROPIC_API_KEY or an `ant auth login` profile.

import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { EFFORTS, type Effort } from "./capabilities";
import { fail, positiveInt } from "./cli";
import type { Json } from "./mcp";
import { paintScoped } from "./paint";
import { promptsFor } from "./prompt";
import { thinkingLog } from "./thinking-log";

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    "thinking-budget": { type: "string", default: "8000" },
    "max-assignments": { type: "string", default: "2000" },
    random: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (args.help) {
  console.log(`Usage: agentpaint-painter --url MCP_URL [options]

  --url              a painting's MCP URL, /mcp/p/<id>/<key> (default $AGENTPAINT_MCP_URL), or
                     /mcp/p/<id> with the agent key in $AGENTPAINT_AGENT_KEY
  --model            Claude model (default $PAINTER_MODEL or claude-opus-5-5)
  --effort           ${EFFORTS.join(" | ")}, sent only to models that support it (default $PAINTER_EFFORT;
                     without either, no effort is sent and each model runs at its own default)
  --thinking-budget  extended-thinking tokens for models without adaptive thinking (default 8000)
  --max-assignments  stop a painting after this many assignments (default 2000)
  --random           random strokes, no Claude`);
  process.exit(0);
}

const rawUrl = args.url ?? process.env.AGENTPAINT_MCP_URL;
if (!rawUrl) fail("--url is required: the painting's MCP URL, shown on its page");
const url = new URL(rawUrl);
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
if (!/^\/mcp\/p\/[0-9A-Za-z]{12}(\/[0-9A-Za-z]{32})?$/.test(url.pathname)) {
  fail("--url must be a painting's MCP URL: /mcp/p/<id>/<key>, or /mcp/p/<id> with AGENTPAINT_AGENT_KEY");
}
const withKey = /\/[0-9A-Za-z]{32}$/.test(url.pathname);
const bearer = withKey ? undefined : process.env.AGENTPAINT_AGENT_KEY;
if (!withKey && !bearer)
  fail("this URL has no key in its path; set AGENTPAINT_AGENT_KEY to the painting's agent key");
const paintingId = url.pathname.split("/")[3] as string;
// Whether the agent can end the painting early picks the prompts.
const info = await fetch(`${url.origin}/api/paintings/${paintingId}`);
if (!info.ok) fail(`GET /api/paintings/${paintingId} returned ${info.status}`);
const allowFinish = ((await info.json()) as Json).allowFinish === true;
console.log(
  `Painting ${paintingId}: ${args.random ? "random strokes" : `${model}, effort ${effortLabel}, a new conversation per assignment`}, ` +
    `${allowFinish ? "agent can end it early" : "ends when its budget is used"}, prompts ${promptsFor(allowFinish).hash}`,
);
const thoughts = thinkingLog(paintingId);
const summary = await paintScoped(anthropic, {
  mcpUrl: url,
  bearer,
  random: args.random,
  allowFinish,
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
