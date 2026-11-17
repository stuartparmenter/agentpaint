// Request parameters per model, from the Models API: newer parameters are sent
// only to models that accept them, and what was sent is reported.

import type Anthropic from "@anthropic-ai/sdk";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface ModelParams {
  model: string;
  max_tokens: number;
  output_config?: { effort: Effort };
  thinking?: { type: "adaptive" } | { type: "enabled"; budget_tokens: number };
  /** What was sent, for the record (and reported with each stroke). */
  sent: { effort: Effort | null; thinking: string };
}

type Leaf = { supported?: boolean };
type Capabilities = {
  effort?: Leaf & Partial<Record<Effort, Leaf>>;
  thinking?: Leaf & { types?: { adaptive?: Leaf; enabled?: Leaf } };
};

const cache = new Map<string, Promise<ModelParams>>();

/**
 * Parameters for `model` at `effort`. Adaptive thinking where supported, else
 * extended thinking with `thinkingBudget` tokens where supported; effort only
 * where the model supports that level. Unknown capabilities send neither.
 */
export function paramsFor(client: Anthropic, model: string, effort: Effort, thinkingBudget: number) {
  const key = `${model}:${effort}:${thinkingBudget}`;
  let entry = cache.get(key);
  if (!entry) {
    entry = resolve(client, model, effort, thinkingBudget);
    cache.set(key, entry);
  }
  return entry;
}

async function resolve(client: Anthropic, model: string, effort: Effort, thinkingBudget: number) {
  let caps: Capabilities = {};
  let maxOutput = 16000;
  try {
    const info = await client.models.retrieve(model);
    caps = (info as unknown as { capabilities?: Capabilities }).capabilities ?? {};
    maxOutput = Math.min(maxOutput, (info as unknown as { max_tokens?: number }).max_tokens ?? maxOutput);
  } catch (e) {
    console.warn(
      `could not read capabilities for ${model}; sending no effort or thinking settings (${String(e)})`,
    );
  }
  const params: ModelParams = { model, max_tokens: maxOutput, sent: { effort: null, thinking: "default" } };
  if (caps.effort?.supported && caps.effort[effort]?.supported) {
    params.output_config = { effort };
    params.sent.effort = effort;
  }
  if (caps.thinking?.types?.adaptive?.supported) {
    params.thinking = { type: "adaptive" };
    params.sent.thinking = "adaptive";
  } else if (caps.thinking?.types?.enabled?.supported) {
    const budget = Math.min(thinkingBudget, maxOutput - 4000);
    if (budget >= 1024) {
      params.thinking = { type: "enabled", budget_tokens: budget };
      params.sent.thinking = `enabled:${budget}`;
    }
  }
  return params;
}
