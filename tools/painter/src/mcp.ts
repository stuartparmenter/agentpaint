// MCP client helpers shared by the painter and the repo's tooling scripts.

import { Client, SdkHttpError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// biome-ignore lint/suspicious/noExplicitAny: JSON from tool results and the API is untyped.
export type Json = Record<string, any>;

export type McpContent = { type: string; text?: string; data?: string; mimeType?: string };

/** Connect to an MCP URL, with an optional bearer token and extra request headers. */
export async function connect(url: URL, bearer?: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: "agentpaint-painter", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: bearer ? { ...headers, Authorization: `Bearer ${bearer}` } : headers },
    }),
  );
  return client;
}

/** Call a tool, waiting out the server's rate limit (HTTP 429) and retrying. */
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

/** The first text block that holds a JSON object, parsed; `{}` when there is none. */
export function firstJson(content: McpContent[]): Json {
  const text = content.find((c) => c.type === "text" && c.text?.startsWith("{"))?.text;
  return text ? JSON.parse(text) : {};
}
