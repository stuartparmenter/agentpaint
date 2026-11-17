// Check that replaying a painting's stroke log reproduces its canvas byte for byte.
// The painting (owner key needed) rebuilds its canvas from an empty canvas and
// from its latest checkpoint, and compares both with the stored snapshot of its
// latest stroke.
//   bun tooling/replay-check.ts --keys .matrix/<series>.json
//   bun tooling/replay-check.ts --painting <id> --owner-key <key> [--url http://127.0.0.1:8787]

import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    keys: { type: "string" },
    painting: { type: "string" },
    "owner-key": { type: "string" },
    url: { type: "string" },
  },
});

let failures = 0;

async function verify(origin: string, id: string, ownerKey: string) {
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
  for (const p of file.paintings) await verify(origin, p.id, p.owner_key);
} else if (args.painting) {
  if (!args["owner-key"]) throw new Error("--owner-key is required with --painting");
  const origin = (args.url ?? process.env.AGENTPAINT_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  await verify(origin, args.painting, args["owner-key"]);
} else {
  throw new Error("pass --keys <file>, or --painting <id> with --owner-key <key>");
}

process.exit(failures ? 1 : 0);
