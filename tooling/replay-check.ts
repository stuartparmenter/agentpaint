// Check that a painting's live canvas matches its stored snapshot byte for byte.
// Run after restarting `wrangler dev` to verify that checkpoint + stroke replay
// rebuilds the exact same canvas.
//
//   AGENTPAINT_URL=http://127.0.0.1:8787 AGENTPAINT_TOKEN=... bun tooling/replay-check.ts

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const base = (process.env.AGENTPAINT_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.AGENTPAINT_TOKEN;
if (!token) throw new Error("AGENTPAINT_TOKEN is required");

const client = new Client({ name: "agentpaint-replay-check", version: "0.1.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);
const result = await client.callTool({ name: "get_assignment", arguments: {} });
const content = result.content as { type: string; text?: string; data?: string }[];
const meta = JSON.parse(content.find((c) => c.type === "text")?.text ?? "{}");
const live = content.find((c) => c.type === "image")?.data ?? "";
const paintingId = String(meta.token).split("-")[0];

const stored = await fetch(`${base}/api/paintings/${paintingId}/v/${meta.stroke_count}`);
const storedB64 = Buffer.from(await stored.arrayBuffer()).toString("base64");
await client.close();

const same = stored.ok && storedB64 === live;
console.log(
  `${paintingId} at stroke ${meta.stroke_count}: live canvas ${same ? "matches" : "DIFFERS FROM"} the stored snapshot`,
);
process.exit(same ? 0 : 1);
