// Delete paintings with the owner keys saved by `bun run matrix`, and remove them
// from the keys file.
//   bun tooling/delete-paintings.ts --keys .matrix/<series>.json --id <id> [--id <id> ...]

import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    keys: { type: "string" },
    id: { type: "string", multiple: true },
    url: { type: "string" },
  },
});

if (!args.keys || !args.id?.length) {
  throw new Error("pass --keys <file> and at least one --id <painting>");
}
const file = JSON.parse(await Bun.file(args.keys).text()) as {
  origin: string;
  paintings: { id: string; owner_key: string }[];
};
const origin = (args.url ?? file.origin).replace(/\/$/, "");

const deleted = new Set<string>();
for (const id of args.id) {
  const painting = file.paintings.find((p) => p.id === id);
  if (!painting) {
    console.log(`${id}: not in ${args.keys}`);
    continue;
  }
  const res = await fetch(`${origin}/api/paintings/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${painting.owner_key}` },
  });
  if (res.ok) deleted.add(id);
  console.log(`${id}: ${res.ok ? "deleted" : `delete failed (${res.status})`}`);
}

if (deleted.size) {
  file.paintings = file.paintings.filter((p) => !deleted.has(p.id));
  await Bun.write(args.keys, JSON.stringify(file, null, 2));
  console.log(`Removed ${deleted.size} painting(s) from ${args.keys}`);
}
process.exit(deleted.size === args.id.length ? 0 : 1);
