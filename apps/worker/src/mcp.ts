import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Agent } from "./auth";
import { DEFAULT_MAX_ACTIVE_PAINTINGS, envNumber, MAX_BATCH, NOTE_MAX } from "./config";
import { MODEL_ID, parseToken } from "./ids";
import type { Assignment, SubmitResult } from "./painting";
import { batchStrokeInput, strokeInput } from "./stroke";

const ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

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

function image(bytes: Uint8Array) {
  return { type: "image" as const, data: base64(bytes), mimeType: "image/jpeg" };
}

/** Serve one MCP request (JSON responses, no sessions) with a server built for it. */
function serve(request: Request, build: () => McpServer, parsedBody: unknown): Promise<Response> {
  const handler = createMcpHandler(build, {
    responseMode: "json",
    onerror: (e) => console.error("mcp error", e),
  });
  return handler.fetch(request, { parsedBody });
}

// --- Pooled endpoint (/mcp): bearer-token agents, leased pool paintings -----------

const POOL_INSTRUCTIONS =
  "AgentPaint is a collaborative painting studio: many agents paint shared canvases one stroke at a time. " +
  "Call get_assignment to receive a canvas and its metadata, look at it, then call submit_stroke once with " +
  "the token and a single brush stroke. Repeat to keep painting.";

/** Result shape of the pooled endpoint's submit_stroke. */
function poolResult(r: SubmitResult) {
  if (r.applied) {
    return { applied: true, stroke_count: r.stroke_count, max_strokes: r.max_strokes, status: r.status };
  }
  return {
    applied: false,
    reason: r.reason,
    ...(r.detail ? { detail: r.detail } : {}),
  };
}

function poolAssignmentResult(assignment: Assignment) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(assignment.metadata) },
      ...(assignment.images ? [image(assignment.images.canvas)] : []),
    ],
  };
}

export function buildServer(env: Env, agent: Agent): McpServer {
  const server = new McpServer({ name: "agentpaint", version: "0.1.0" }, { instructions: POOL_INSTRUCTIONS });

  server.registerTool(
    "get_assignment",
    {
      description:
        "Get a painting assignment: a snapshot of a canvas (JPEG) plus metadata, including the subject prompt " +
        "(null means it's up to the painters) and the maximum brush size. " +
        "The canvas is reserved for you for a few minutes. Then call submit_stroke with the token.",
      inputSchema: z.object({}),
      annotations: ANNOTATIONS,
    },
    async () => {
      const registry = env.REGISTRY.getByName("registry");
      const maxActive = envNumber(env.MAX_ACTIVE_PAINTINGS, DEFAULT_MAX_ACTIVE_PAINTINGS);
      for (let attempt = 0; attempt < 3; attempt++) {
        const lease = await registry.lease(maxActive);
        if (!lease) {
          return text({
            available: false,
            message: "Every painting is being worked on right now. Try again in a minute.",
          });
        }
        const painting = env.PAINTING.getByName(lease.painting.id);
        if (lease.created) await painting.init(lease.painting);
        const assignment = await painting.assign(agent.name);
        if (assignment === null) {
          // The painting has no state yet (its creation was interrupted): create it.
          await painting.init(lease.painting);
          const retried = await painting.assign(agent.name);
          if (retried && "token" in retried) return poolAssignmentResult(retried);
          await registry.release(lease.painting.id);
        } else if ("token" in assignment) {
          return poolAssignmentResult(assignment);
        } else {
          // The painting finished but the registry hadn't heard yet: resync and try another.
          await registry.recordStroke(lease.painting.id, {
            strokeCount: assignment.strokeCount,
            status: assignment.status,
            at: Date.now(),
          });
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
        "pixels. Each token paints one stroke. A rejected stroke (invalid_stroke) leaves the " +
        "token usable, so fix it and resubmit (resubmit as-is on temporary_failure); stale_assignment or " +
        "token_expired mean call get_assignment again.",
      inputSchema: z.object({
        token: z.string().max(64).describe("The token from get_assignment"),
        stroke_data: strokeInput,
      }),
      annotations: ANNOTATIONS,
    },
    async ({ token, stroke_data }) => {
      const parsed = parseToken(token);
      if (!parsed) return text({ applied: false, reason: "invalid_token" }, true);
      const result = await env.PAINTING.getByName(parsed.paintingId).submit(
        parsed.secret,
        [stroke_data],
        agent.name,
      );
      return text(poolResult(result), !result.applied);
    },
  );

  return server;
}

export function handleMcp(request: Request, env: Env, agent: Agent, parsedBody: unknown): Promise<Response> {
  return serve(request, () => buildServer(env, agent), parsedBody);
}

// --- Scoped endpoint (/mcp/p/<id>): one created painting -------------------------

/** Agent label recorded for strokes made through a painting's own endpoint. */
export const SCOPED_AGENT = "scoped";

const SCOPED_INSTRUCTIONS =
  "This endpoint paints one AgentPaint painting. Call get_assignment for an assignment: it returns the painting's " +
  "metadata, the current canvas and, when the painting has one, its reference image. An assignment's token allows " +
  "metadata.assignment_strokes_remaining strokes, submitted with submit_stroke one at a time or in batches; no new " +
  "image is shown until they are used. Then call get_assignment for the next assignment. " +
  "metadata.painting_strokes_remaining is how many strokes are left in the painting's budget.";

export function buildScopedServer(env: Env, paintingId: string): McpServer {
  const server = new McpServer(
    { name: "agentpaint", version: "0.1.0" },
    { instructions: SCOPED_INSTRUCTIONS },
  );
  const painting = () => env.PAINTING.getByName(paintingId);

  server.registerTool(
    "get_assignment",
    {
      description:
        "Get an assignment on this painting. A new assignment returns the metadata, then the reference image (if " +
        "the painting has one) and the current canvas, each labeled. The assignment's token allows " +
        "metadata.assignment_strokes_remaining strokes; metadata.painting_strokes_remaining is how many strokes " +
        "are left in the painting's budget. While an assignment still has strokes left, this returns the same " +
        "token and metadata with new_assignment false and no images.",
      inputSchema: z.object({}),
      annotations: ANNOTATIONS,
    },
    async () => {
      const assignment = await painting().assign(SCOPED_AGENT);
      if (!assignment) throw new Error("This painting does not exist.");
      if (!("token" in assignment)) {
        return text({
          available: false,
          status: assignment.status,
          message: `This painting is ${assignment.status}.`,
        });
      }
      const content: ({ type: "text"; text: string } | ReturnType<typeof image>)[] = [
        { type: "text", text: JSON.stringify(assignment.metadata) },
      ];
      if (assignment.images?.reference) {
        content.push({ type: "text", text: "Reference image:" }, image(assignment.images.reference));
      }
      if (assignment.images)
        content.push({ type: "text", text: "Current canvas:" }, image(assignment.images.canvas));
      return { content };
    },
  );

  server.registerTool(
    "submit_stroke",
    {
      description:
        "Submit strokes on the current assignment's token: either stroke_data (one stroke) or strokes (a batch of " +
        `up to the assignment's assignment_strokes_remaining, at most ${MAX_BATCH}). Coordinates and brush size ` +
        "are in canvas pixels. " +
        "A batch is validated as a whole before any of it is applied; a rejection names the index of the first " +
        "invalid stroke and leaves the token usable. finished: true ends the painting after these strokes (the " +
        "stroke budget is a ceiling). model, effort, input_tokens, output_tokens and prompt_hash are optional " +
        "self-reported details recorded with the strokes.",
      inputSchema: z.object({
        token: z.string().max(64).describe("The token from get_assignment"),
        stroke_data: strokeInput.optional().describe("A single stroke"),
        note: z
          .string()
          .max(NOTE_MAX)
          .optional()
          .describe("One line on what the single stroke is for (optional)"),
        strokes: z
          .array(batchStrokeInput)
          .max(MAX_BATCH)
          .optional()
          .describe("A batch of strokes, applied in order"),
        finished: z.boolean().optional().describe("End the painting after these strokes"),
        model: z.string().regex(MODEL_ID).optional().describe("Your model id, if you know it (optional)"),
        effort: z.string().max(20).optional(),
        input_tokens: z.number().int().min(0).max(1e9).optional(),
        output_tokens: z.number().int().min(0).max(1e9).optional(),
        prompt_hash: z.string().max(128).optional(),
      }),
      annotations: ANNOTATIONS,
    },
    async (args) => {
      const parsed = parseToken(args.token);
      if (!parsed || parsed.paintingId !== paintingId) {
        return text({ applied: false, applied_count: 0, reason: "invalid_token" }, true);
      }
      if (args.stroke_data && args.strokes) {
        return text(
          {
            applied: false,
            applied_count: 0,
            reason: "invalid_stroke",
            detail: "Send stroke_data or strokes, not both.",
          },
          true,
        );
      }
      const strokes = args.strokes ?? (args.stroke_data ? [{ ...args.stroke_data, note: args.note }] : []);
      const result = await painting().submit(parsed.secret, strokes, SCOPED_AGENT, {
        finished: args.finished,
        model: args.model,
        effort: args.effort,
        inputTokens: args.input_tokens,
        outputTokens: args.output_tokens,
        promptHash: args.prompt_hash,
      });
      return text(result, !result.applied);
    },
  );

  return server;
}

export function handleScopedMcp(
  request: Request,
  env: Env,
  paintingId: string,
  parsedBody: unknown,
): Promise<Response> {
  return serve(request, () => buildScopedServer(env, paintingId), parsedBody);
}
