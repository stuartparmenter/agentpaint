import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Agent } from "./auth";
import { DEFAULT_MAX_ACTIVE_PAINTINGS } from "./config";
import { parseToken } from "./ids";
import type { Assignment, SubmitResult } from "./painting";
import { strokeInput } from "./stroke";

const INSTRUCTIONS =
  "AgentPaint is a collaborative painting studio: many agents paint shared canvases one stroke at a time. " +
  "Call get_assignment to receive a canvas and its metadata, look at it, then call submit_stroke once with " +
  "the token and a single brush stroke. Repeat to keep painting.";

function text(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    ...(isError ? { isError } : {}),
  };
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function assignmentResult(assignment: Assignment) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(assignment.metadata) },
      { type: "image" as const, data: base64(assignment.image), mimeType: "image/jpeg" },
    ],
  };
}

function maxActive(env: Env): number {
  const n = Number(env.MAX_ACTIVE_PAINTINGS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_ACTIVE_PAINTINGS;
}

export function buildServer(env: Env, agent: Agent): McpServer {
  const server = new McpServer({ name: "agentpaint", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "get_assignment",
    {
      description:
        "Get a painting assignment: a snapshot of a canvas (JPEG) plus metadata, including the subject prompt " +
        "(null means it's up to the painters), the current phase, its guidance and the minimum brush size. " +
        "The canvas is reserved for you for a few minutes. Then call submit_stroke with the token.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const registry = env.REGISTRY.getByName("registry");
      for (let attempt = 0; attempt < 3; attempt++) {
        const lease = await registry.lease(maxActive(env));
        if (!lease) {
          return text({
            available: false,
            message: "Every painting is being worked on right now. Try again in a minute.",
          });
        }
        const painting = env.PAINTING.getByName(lease.painting.id);
        if (lease.created) await painting.init(lease.painting);
        const assignment = await painting.assign(agent.name);
        if (assignment) return assignmentResult(assignment);

        const state = await painting.state();
        if (!state) {
          // Its creation was interrupted before the painting stored anything: finish it.
          await painting.init(lease.painting);
          const retried = await painting.assign(agent.name);
          if (retried) return assignmentResult(retried);
          await registry.release(lease.painting.id);
        } else {
          // The painting finished but the registry hadn't heard yet: resync and try another.
          await registry.recordStroke(lease.painting.id, state.strokeCount, state.status, Date.now());
        }
      }
      return text({ available: false, message: "No painting available right now. Try again shortly." });
    },
  );

  server.registerTool(
    "submit_stroke",
    {
      description:
        "Submit one brush stroke to the painting from your assignment. Coordinates and brush size are in canvas " +
        "pixels. Each token paints one stroke. A rejected stroke (invalid_stroke, brush_too_small) leaves the " +
        "token usable, so fix it and resubmit (resubmit as-is on temporary_failure); stale_assignment or " +
        "token_expired mean call get_assignment again.",
      inputSchema: z.object({
        token: z.string().max(64).describe("The token from get_assignment"),
        stroke_data: strokeInput,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ token, stroke_data }) => {
      const parsed = parseToken(token);
      if (!parsed) return text({ applied: false, reason: "invalid_token" } satisfies SubmitResult, true);
      const result = await env.PAINTING.getByName(parsed.paintingId).submit(
        parsed.secret,
        stroke_data,
        agent.name,
      );
      return text(result, !result.applied);
    },
  );

  return server;
}

export function handleMcp(request: Request, env: Env, agent: Agent, parsedBody: unknown): Promise<Response> {
  const handler = createMcpHandler(() => buildServer(env, agent), {
    responseMode: "json",
    onerror: (e) => console.error("mcp error", e),
  });
  return handler.fetch(request, { parsedBody });
}
