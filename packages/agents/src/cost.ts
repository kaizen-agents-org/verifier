import type { RunMeta } from "@verifier/core";
import type { Usage } from "@anthropic-ai/sdk/resources/messages";
import { INTENT_AGENT_CONFIG, INTENT_AGENT_PRICING_USD_PER_MILLION } from "./config.js";

export type AgentUsage = Pick<
  Usage,
  "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens"
>;

export function recordAgentUsage(runMeta: RunMeta, usage: AgentUsage): RunMeta {
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const uncachedInputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const inputTokens = uncachedInputTokens + cacheWriteTokens + cacheReadTokens;
  const requestUsd =
    (uncachedInputTokens * INTENT_AGENT_PRICING_USD_PER_MILLION.input +
      cacheWriteTokens * INTENT_AGENT_PRICING_USD_PER_MILLION.cacheWrite5m +
      cacheReadTokens * INTENT_AGENT_PRICING_USD_PER_MILLION.cacheRead +
      outputTokens * INTENT_AGENT_PRICING_USD_PER_MILLION.output) /
    1_000_000;

  return {
    ...runMeta,
    agentConfig: { ...INTENT_AGENT_CONFIG },
    cost: {
      inputTokens: runMeta.cost.inputTokens + inputTokens,
      outputTokens: runMeta.cost.outputTokens + outputTokens,
      usd: runMeta.cost.usd + requestUsd
    }
  };
}
