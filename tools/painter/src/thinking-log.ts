// Saves each look's thinking summaries to .matrix/thinking/<painting id>.jsonl at
// the repository root (gitignored), one JSON line per look.

import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ThinkingEntry } from "./paint";

const dir = new URL("../../../.matrix/thinking/", import.meta.url);

/** A writer for one painting's thinking log, and the path it writes to. */
export function thinkingLog(paintingId: string) {
  const file = new URL(`${paintingId}.jsonl`, dir);
  return {
    path: fileURLToPath(file),
    write(entry: ThinkingEntry) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    },
  };
}
