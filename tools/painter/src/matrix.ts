#!/usr/bin/env bun
// Paint a model ladder: one series with a painting per model x strokes per
// assignment x repeat, painted in parallel, then print the series' results table.
//
//   bun src/matrix.ts --url http://127.0.0.1:8787 \
//     --models claude-haiku-4-5,claude-sonnet-5-5,claude-opus-5-5 --per-assignment 1,20,all \
//     --reference krita-sunset --size study --repeat 2 --parallel 3
//
// --join .matrix/<series>.json adds the paintings to that file's series instead
// of starting a new one, and appends their keys to the file.

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { EFFORTS, type Effort } from "./capabilities";
import { fail, positiveInt } from "./cli";
import type { Json } from "./mcp";
import { type PaintSummary, paintScoped } from "./paint";
import { promptsFor } from "./prompt";
import { thinkingLog } from "./thinking-log";

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    join: { type: "string" },
    models: { type: "string", default: "claude-opus-5-5" },
    "per-assignment": { type: "string", default: "1,20,all" },
    style: { type: "string" },
    reference: { type: "string" },
    prompt: { type: "string" },
    size: { type: "string", default: "study" },
    "max-strokes": { type: "string" },
    repeat: { type: "string", default: "1" },
    parallel: { type: "string", default: "3" },
    effort: { type: "string" },
    "thinking-budget": { type: "string", default: "8000" },
    "no-finish": { type: "boolean", default: false },
    random: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (args.help) {
  console.log(`Usage: matrix [options]

  --url            site origin (default: the --join file's, else http://127.0.0.1:8787)
  --join           a keys file (.matrix/<series>.json, relative to the repository root): add the
                   paintings to its series and its file
  --models         comma-separated model ids (ignored with --random)
  --per-assignment strokes per assignment, comma-separated; "all" = the whole budget in one assignment
                   (default 1,20,all)
  --style          painting style (default: the reference's style, else landscape)
  --reference      built-in reference id (e.g. krita-sunset)
  --prompt         subject text (default: none)
  --size           full | study (default study)
  --max-strokes    stroke budget (default: the style's for the size)
  --no-finish      the agent can't end its paintings early; each ends when its budget is used
  --repeat         paintings per cell (default 1)
  --parallel       paintings painted at once (default 3)
  --effort         ${EFFORTS.join(" | ")}, sent only where supported (default: none sent, so each
                   model runs at its own default effort)
  --random         random strokes instead of Claude`);
  process.exit(0);
}

interface KeysFile {
  origin: string;
  series_id: string;
  series_key: string;
  paintings: Json[];
}
// `bun run matrix` runs in tools/painter; keys files are under the repository root.
const repoRoot = new URL("../../../", import.meta.url).pathname;
const joinFile = args.join ? resolve(repoRoot, args.join) : null;
const joined = joinFile ? (JSON.parse(await Bun.file(joinFile).text()) as KeysFile) : null;
const origin = (args.url ?? joined?.origin ?? "http://127.0.0.1:8787").replace(/\/$/, "");
if (joined && joined.origin.replace(/\/$/, "") !== origin) {
  fail(`${joinFile} holds a series on ${joined.origin}, not ${origin}`);
}
const effort = (args.effort ?? null) as Effort | null;
if (effort !== null && !EFFORTS.includes(effort)) fail(`--effort must be one of ${EFFORTS.join(", ")}`);
const repeat = positiveInt(args.repeat, "--repeat");
const parallel = positiveInt(args.parallel, "--parallel");
const thinkingBudget = positiveInt(args["thinking-budget"], "--thinking-budget");
const allowFinish = !args["no-finish"];
const prompts = promptsFor(allowFinish);

let styleName = args.style ?? "landscape";
if (args.reference && !args.style) {
  const references = (await (await fetch(`${origin}/api/references`)).json()) as {
    id: string;
    style: string;
  }[];
  const reference =
    references.find((r) => r.id === args.reference) ?? fail(`unknown reference ${args.reference}`);
  styleName = reference.style;
}
const styles = (await (await fetch(`${origin}/api/styles`)).json()) as {
  name: string;
  max_strokes: { full: number; study: number };
}[];
const style = styles.find((s) => s.name === styleName) ?? fail(`unknown style ${styleName}`);
const size = args.size === "full" ? "full" : "study";
const budget = args["max-strokes"]
  ? positiveInt(args["max-strokes"], "--max-strokes")
  : style.max_strokes[size];
const perAssignment = args["per-assignment"].split(",").map((l) => {
  const n = l.trim() === "all" ? budget : Number(l);
  if (!Number.isInteger(n) || n < 1) fail(`bad --per-assignment value "${l}"`);
  return Math.min(n, budget);
});
const models = args.random
  ? ["random"]
  : args.models
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);

interface Cell {
  model: string;
  strokesPerAssignment: number;
  rep: number;
  id?: string;
  mcpUrl?: string;
  ownerKey?: string;
  summary?: PaintSummary;
  error?: string;
}
const cells: Cell[] = models.flatMap((model) =>
  perAssignment.flatMap((strokesPerAssignment) =>
    Array.from({ length: repeat }, (_, rep) => ({ model, strokesPerAssignment, rep })),
  ),
);

async function create(settings: Record<string, unknown>) {
  for (;;) {
    const res = await fetch(`${origin}/api/paintings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    if (res.status === 429) {
      console.log("creation rate limit reached; waiting 60s");
      await Bun.sleep(60_000);
      continue;
    }
    const body = (await res.json()) as Json;
    if (!res.ok) fail(`creating a painting failed (${res.status}): ${JSON.stringify(body)}`);
    return body;
  }
}

if (joined) console.log(`Joining series ${joined.series_id} (${joined.paintings.length} paintings so far)`);
console.log(
  `Matrix: ${models.length} model(s) x ${perAssignment.length} strokes-per-assignment setting(s) x ${repeat} = ${cells.length} paintings; ` +
    `${style.name}, ${size}, budget ${budget}, ${allowFinish ? "agent can end early" : "no finishing"}, ` +
    `effort ${effort ?? "default"}, prompts ${prompts.hash}`,
);

let series: { id: string; key: string } | null = joined
  ? { id: joined.series_id, key: joined.series_key }
  : null;
for (const cell of cells) {
  const body = await create({
    style: style.name,
    prompt: args.prompt ?? null,
    reference: args.reference ?? null,
    size,
    max_strokes: budget,
    strokes_per_assignment: cell.strokesPerAssignment,
    allow_finish: allowFinish,
    ...(series ? { series: series.id, series_key: series.key } : {}),
  });
  series ??= { id: body.series_id, key: body.series_key };
  cell.id = body.id;
  cell.mcpUrl = body.mcp_url;
  cell.ownerKey = body.owner_key;
}
if (!series) fail("no paintings created");
// The series' keys, for joining, verifying (tooling/replay-check.ts --keys) or
// deleting (tooling/delete-paintings.ts) its paintings later.
const keysFile = joinFile ?? resolve(repoRoot, `.matrix/${series.id}.json`);
const keys: KeysFile = {
  origin,
  series_id: series.id,
  series_key: series.key,
  paintings: [
    ...(joined?.paintings ?? []),
    ...cells.map((c) => ({
      id: c.id,
      model: c.model,
      strokes_per_assignment: c.strokesPerAssignment,
      mcp_url: c.mcpUrl,
      owner_key: c.ownerKey,
    })),
  ],
};
await Bun.write(keysFile, JSON.stringify(keys, null, 2));
console.log(`Keys saved to ${keysFile}`);

const anthropic = args.random ? null : new Anthropic();
const queue = [...cells];
await Promise.all(
  Array.from({ length: Math.min(parallel, queue.length) }, async () => {
    for (let cell = queue.shift(); cell; cell = queue.shift()) {
      const tag = `[${cell.model} ${cell.strokesPerAssignment}/assignment #${cell.rep + 1} ${cell.id}]`;
      try {
        cell.summary = await paintScoped(anthropic, {
          mcpUrl: new URL(cell.mcpUrl as string),
          random: args.random,
          allowFinish,
          model: cell.model,
          effort,
          thinkingBudget,
          maxAssignments: budget + 10,
          log: (line) => console.log(`${tag} ${line}`),
          onThinking: thinkingLog(cell.id as string).write,
        });
        console.log(`${tag} done: ${cell.summary.stopReason}, ${cell.summary.strokes} strokes`);
      } catch (e) {
        cell.error = e instanceof Error ? e.message : String(e);
        console.error(`${tag} failed: ${cell.error}`);
      }
    }
  }),
);

// Results come from the server's record; wait out the endpoint's 5-second edge cache.
await Bun.sleep(6000);
const result = (await (await fetch(`${origin}/api/series/${series.id}`)).json()) as {
  paintings: { blankScore: number | null; meanColorScore: number | null }[];
  table: Record<string, number | string | null>[];
};
const first = result.paintings[0];
const fmt = (v: unknown, digits = 3) => (typeof v === "number" ? v.toFixed(digits) : "—");
// Scores on the scale the pages show: 0 is a blank canvas, 1 is identical to the reference.
const blank = first?.blankScore ?? null;
const similarity = (raw: unknown) =>
  typeof raw === "number" && blank !== null ? fmt((raw - blank) / (1 - blank), 2) : "—";
const rows = result.table.map((c) => [
  String(c.models),
  String(c.strokes_per_assignment),
  `${c.finished}/${c.paintings}`,
  similarity(c.final_score),
  fmt(c.strokes_used, 1),
  fmt(c.assignments, 1),
  typeof c.mean_think_ms === "number" ? `${(c.mean_think_ms / 1000).toFixed(1)}s` : "—",
  fmt(c.tokens_in, 0),
  fmt(c.tokens_out, 0),
]);
const header = [
  "models",
  "strokes/assignment",
  "finished",
  "final score",
  "strokes",
  "assignments",
  "think/stroke",
  "tokens in",
  "tokens out",
];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
const line = (r: string[]) => r.map((v, i) => v.padEnd(widths[i] ?? 0)).join("  ");
console.log("");
console.log(line(header));
for (const r of rows) console.log(line(r));
if (blank !== null) {
  console.log(
    `\nScores: 0 is a blank canvas, 1 is identical; one flat average color scores ${similarity(first?.meanColorScore)}.`,
  );
}
const sent = cells.find((c) => c.summary?.sent)?.summary?.sent;
for (const model of models) {
  const s = cells.find((c) => c.model === model && c.summary?.sent)?.summary?.sent;
  if (s) console.log(`${model}: sent effort ${s.effort ?? "default (not sent)"}, thinking ${s.thinking}`);
}
if (!sent && !args.random) console.log("(no request parameters recorded)");
const failed = cells.filter((c) => c.error);
if (failed.length)
  console.log(`\n${failed.length} painting(s) failed: ${failed.map((c) => c.id).join(", ")}`);
if (args.reference) console.log(`\nResults: ${origin}/tests/${args.reference}?series=${series.id}`);
else for (const c of cells) console.log(`${origin}/p/${c.id}`);
