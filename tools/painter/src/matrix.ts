#!/usr/bin/env bun
// Paint a model ladder: one series with a painting per model x look setting x
// repeat, painted in parallel, then print the series' results table.
//
//   bun src/matrix.ts --url http://127.0.0.1:8787 \
//     --models claude-haiku-4-5,claude-sonnet-5-5,claude-opus-5-5 --looks 1,20,all \
//     --style landscape --reference krita-sunset --size study --repeat 2 --parallel 3

import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { EFFORTS, type Effort } from "./capabilities";
import { type PaintSummary, paintScoped } from "./paint";
import { PROMPT_HASH } from "./prompt";

// biome-ignore lint/suspicious/noExplicitAny: JSON from tool results and the API is untyped.
type Json = Record<string, any>;

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:8787" },
    models: { type: "string", default: "claude-opus-5-5" },
    looks: { type: "string", default: "1,20,all" },
    style: { type: "string", default: "landscape" },
    reference: { type: "string" },
    prompt: { type: "string" },
    size: { type: "string", default: "study" },
    phases: { type: "string", default: "off" },
    "max-strokes": { type: "string" },
    repeat: { type: "string", default: "1" },
    parallel: { type: "string", default: "3" },
    effort: { type: "string", default: "medium" },
    "thinking-budget": { type: "string", default: "8000" },
    "keep-context": { type: "boolean", default: false },
    random: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (args.help) {
  console.log(`Usage: matrix [options]

  --url            site origin (default http://127.0.0.1:8787)
  --models         comma-separated model ids (ignored with --random)
  --looks          strokes per look, comma-separated; "all" = the whole budget on one look (default 1,20,all)
  --style          painting style (default landscape)
  --reference      built-in reference id (e.g. krita-sunset)
  --prompt         subject text (default: none)
  --size           full | study (default study)
  --phases         off | guidance | enforced (default off)
  --max-strokes    stroke budget (default: the style's for the size)
  --repeat         paintings per cell (default 1)
  --parallel       paintings painted at once (default 3)
  --effort         ${EFFORTS.join(" | ")} (default medium; sent only where supported)
  --keep-context   one conversation per painting (default: a fresh one per look)
  --random         random strokes instead of Claude`);
  process.exit(0);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const origin = args.url.replace(/\/$/, "");
const effort = args.effort as Effort;
if (!EFFORTS.includes(effort)) fail(`--effort must be one of ${EFFORTS.join(", ")}`);
const repeat = Number(args.repeat);
const parallel = Number(args.parallel);
if (!Number.isInteger(repeat) || repeat < 1) fail("--repeat must be a positive integer");
if (!Number.isInteger(parallel) || parallel < 1) fail("--parallel must be a positive integer");

const styles = (await (await fetch(`${origin}/api/styles`)).json()) as {
  name: string;
  max_strokes: { full: number; study: number };
}[];
const style = styles.find((s) => s.name === args.style) ?? fail(`unknown style ${args.style}`);
const size = args.size === "full" ? "full" : "study";
const budget = args["max-strokes"] ? Number(args["max-strokes"]) : style.max_strokes[size];
const looks = args.looks.split(",").map((l) => {
  const n = l.trim() === "all" ? budget : Number(l);
  if (!Number.isInteger(n) || n < 1) fail(`bad look setting "${l}"`);
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
  strokesPerLook: number;
  rep: number;
  id?: string;
  mcpUrl?: string;
  ownerKey?: string;
  summary?: PaintSummary;
  error?: string;
}
const cells: Cell[] = models.flatMap((model) =>
  looks.flatMap((strokesPerLook) =>
    Array.from({ length: repeat }, (_, rep) => ({ model, strokesPerLook, rep })),
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

console.log(
  `Matrix: ${models.length} model(s) x ${looks.length} look setting(s) x ${repeat} = ${cells.length} paintings; ` +
    `${args.style}, ${size}, budget ${budget}, phases ${args.phases}, ${args["keep-context"] ? "keep" : "fresh"} context, prompts ${PROMPT_HASH}`,
);

let series: { id: string; key: string } | null = null;
for (const cell of cells) {
  const body = await create({
    style: args.style,
    prompt: args.prompt ?? null,
    reference: args.reference ?? null,
    size,
    max_strokes: budget,
    strokes_per_look: cell.strokesPerLook,
    phases: args.phases,
    ...(series ? { series: series.id, series_key: series.key } : {}),
  });
  series ??= { id: body.series_id, key: body.series_key };
  cell.id = body.id;
  cell.mcpUrl = body.mcp_url;
  cell.ownerKey = body.owner_key;
}
if (!series) fail("no paintings created");
// The paintings' keys, for finishing or verifying them later (tooling/replay-check.ts --keys).
const keysDir = new URL("../../../.matrix/", import.meta.url);
const keysFile = new URL(`${series.id}.json`, keysDir);
await Bun.write(
  keysFile,
  JSON.stringify(
    {
      origin,
      series_id: series.id,
      series_key: series.key,
      paintings: cells.map((c) => ({
        id: c.id,
        model: c.model,
        strokes_per_look: c.strokesPerLook,
        mcp_url: c.mcpUrl,
        owner_key: c.ownerKey,
      })),
    },
    null,
    2,
  ),
);
console.log(`Keys saved to ${keysFile.pathname}`);
console.log(`Series ${origin}/s/${series.id}`);

const anthropic = args.random ? null : new Anthropic();
const queue = [...cells];
await Promise.all(
  Array.from({ length: Math.min(parallel, queue.length) }, async () => {
    for (let cell = queue.shift(); cell; cell = queue.shift()) {
      const tag = `[${cell.model} ${cell.strokesPerLook}/look #${cell.rep + 1} ${cell.id}]`;
      try {
        cell.summary = await paintScoped(anthropic, {
          mcpUrl: new URL(cell.mcpUrl as string),
          random: args.random,
          model: cell.model,
          effort,
          thinkingBudget: Number(args["thinking-budget"]),
          context: args["keep-context"] ? "keep" : "fresh",
          maxLooks: budget + 10,
          log: (line) => console.log(`${tag} ${line}`),
        });
        console.log(`${tag} done: ${cell.summary.stopReason}, ${cell.summary.strokes} strokes`);
      } catch (e) {
        cell.error = e instanceof Error ? e.message : String(e);
        console.error(`${tag} failed: ${cell.error}`);
      }
    }
  }),
);

// Results come from the server's record; wait out the endpoint's 4-second edge cache.
await Bun.sleep(5000);
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
  String(c.strokes_per_look),
  `${c.finished}/${c.paintings}`,
  similarity(c.final_score),
  fmt(c.strokes_used, 1),
  fmt(c.looks, 1),
  typeof c.mean_think_ms === "number" ? `${(c.mean_think_ms / 1000).toFixed(1)}s` : "—",
  fmt(c.tokens_in, 0),
  fmt(c.tokens_out, 0),
]);
const header = [
  "models",
  "strokes/look",
  "finished",
  "final score",
  "strokes",
  "looks",
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
  if (s) console.log(`${model}: sent effort ${s.effort ?? "none"}, thinking ${s.thinking}`);
}
if (!sent && !args.random) console.log("(no request parameters recorded)");
const failed = cells.filter((c) => c.error);
if (failed.length)
  console.log(`\n${failed.length} painting(s) failed: ${failed.map((c) => c.id).join(", ")}`);
if (args.reference) console.log(`\nResults: ${origin}/tests/${args.reference}?series=${series.id}`);
else for (const c of cells) console.log(`${origin}/p/${c.id}`);
