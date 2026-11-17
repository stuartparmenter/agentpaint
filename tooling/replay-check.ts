// Check that replaying a painting's stroke log reproduces its canvas byte for byte.
//
// Created paintings (owner key needed): the painting rebuilds its canvas from an
// empty canvas and from its latest checkpoint, and compares both with the stored
// snapshot of its latest stroke.
//   bun tooling/replay-check.ts --keys .matrix/<series>.json
//   bun tooling/replay-check.ts --painting <id> --owner-key <key> [--url http://127.0.0.1:8787]
//
// Pool paintings (after restarting `wrangler dev`, so the canvas is rebuilt):
// gets an assignment and compares the live canvas with the stored snapshot.
//   AGENTPAINT_URL=http://127.0.0.1:8787 AGENTPAINT_TOKEN=... bun tooling/replay-check.ts

import { parseArgs } from "node:util";
import { connect, firstJson, type McpContent } from "../tools/painter/src/mcp";

const { values: args } = parseArgs({
  options: {
    keys: { type: "string" },
    painting: { type: "string" },
    "owner-key": { type: "string" },
    url: { type: "string" },
  },
});

let failures = 0;

async function verifyCreated(origin: string, id: string, ownerKey: string) {
  const res = await fetch(`${origin}/api/paintings/${id}/verify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerKey}` },
  });
  if (!res.ok) {
    console.log(`${id}: verify failed (${res.status})`);
    failures++;
    return;
  }
  const r = (await res.json()) as { version: number; fromScratch: boolean; fromCheckpoint: boolean | null };
  const ok = r.fromScratch && r.fromCheckpoint !== false;
  if (!ok) failures++;
  console.log(
    `${id} at stroke ${r.version}: from scratch ${r.fromScratch ? "matches" : "DIFFERS"}, ` +
      `from checkpoint ${r.fromCheckpoint === null ? "(no checkpoint)" : r.fromCheckpoint ? "matches" : "DIFFERS"}`,
  );
}

if (args.keys) {
  const file = JSON.parse(await Bun.file(args.keys).text()) as {
    origin: string;
    paintings: { id: string; owner_key: string }[];
  };
  const origin = (args.url ?? file.origin).replace(/\/$/, "");
  for (const p of file.paintings) await verifyCreated(origin, p.id, p.owner_key);
} else if (args.painting) {
  if (!args["owner-key"]) throw new Error("--owner-key is required with --painting");
  const origin = (args.url ?? process.env.AGENTPAINT_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  await verifyCreated(origin, args.painting, args["owner-key"]);
} else {
  const base = (args.url ?? process.env.AGENTPAINT_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  const token = process.env.AGENTPAINT_TOKEN;
  if (!token) throw new Error("AGENTPAINT_TOKEN is required for the pool check");
  const client = await connect(new URL(`${base}/mcp`), token);
  const result = await client.callTool({ name: "get_assignment", arguments: {} });
  const content = result.content as McpContent[];
  const meta = firstJson(content);
  const live = content.find((c) => c.type === "image")?.data ?? "";
  const paintingId = meta.painting_id;
  const stored = await fetch(`${base}/api/paintings/${paintingId}/v/${meta.stroke_count}`);
  const storedB64 = Buffer.from(await stored.arrayBuffer()).toString("base64");
  await client.close();
  const same = stored.ok && storedB64 === live;
  if (!same) failures++;
  console.log(
    `${paintingId} at stroke ${meta.stroke_count}: live canvas ${same ? "matches" : "DIFFERS FROM"} the stored snapshot`,
  );
}

process.exit(failures ? 1 : 0);
