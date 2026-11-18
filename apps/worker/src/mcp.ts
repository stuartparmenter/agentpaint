import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { MAX_BATCH, NOTE_MAX } from "./config";
import { MODEL_ID, parseToken } from "./ids";
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

const SCOPED_INSTRUCTIONS =
  "This endpoint paints one AgentPaint painting. Call get_assignment for an assignment: it returns the painting's " +
  "metadata, the current canvas and, when the painting has one, its reference image. An assignment's token allows " +
  "metadata.assignment_strokes_remaining strokes, submitted with submit_stroke one at a time or in batches; no new " +
  "image is shown until they are used. Then call get_assignment for the next assignment. " +
  "metadata.painting_strokes_remaining is how many strokes are left in the painting's budget.";

const submitStrokeInput = z.object({
  token: z.string().max(64).describe("The token from get_assignment"),
  stroke_data: strokeInput.optional().describe("A single stroke"),
  note: z.string().max(NOTE_MAX).optional().describe("One line on what the single stroke is for (optional)"),
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
});

/**
 * submit_stroke's input on a painting the agent can't end early: no `finished`.
 * Other properties pass through, so a `finished` sent anyway reaches the
 * painting, which rejects it.
 */
const submitStrokeInputWithoutFinish = submitStrokeInput.omit({ finished: true }).loose();

/** The MCP server for one painting's endpoint (/mcp/p/<id>). */
function buildScopedServer(env: Env, paintingId: string, allowFinish: boolean): McpServer {
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
      const assignment = await painting().assign();
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
        "invalid stroke and leaves the token usable. " +
        (allowFinish
          ? "finished: true ends the painting after these strokes (the stroke budget is a ceiling). "
          : "") +
        "model, effort, input_tokens, output_tokens and prompt_hash are optional self-reported details recorded " +
        "with the strokes.",
      inputSchema: allowFinish ? submitStrokeInput : submitStrokeInputWithoutFinish,
      annotations: ANNOTATIONS,
    },
    async (args: z.infer<typeof submitStrokeInputWithoutFinish> & { finished?: unknown }) => {
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
      const result = await painting().submit(parsed.secret, strokes, {
        finished: args.finished === true,
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
  allowFinish: boolean,
  parsedBody: unknown,
): Promise<Response> {
  // JSON responses, no sessions: a server is built for each request.
  const handler = createMcpHandler(() => buildScopedServer(env, paintingId, allowFinish), {
    responseMode: "json",
    onerror: (e) => console.error("mcp error", e),
  });
  return handler.fetch(request, { parsedBody });
}
