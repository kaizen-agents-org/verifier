export const INTENT_AGENT_CONFIG = Object.freeze({
  model: "claude-opus-4-8",
  effort: "medium" as const,
  maxTokens: 4_096,
  maxSchemaRetries: 2
});

export const CORRECTNESS_AGENT_CONFIG = INTENT_AGENT_CONFIG;
export const REFUTER_AGENT_CONFIG = INTENT_AGENT_CONFIG;
export const SCENARIO_AGENT_CONFIG = INTENT_AGENT_CONFIG;

export const INTENT_AGENT_PRICING_USD_PER_MILLION = Object.freeze({
  input: 5,
  cacheWrite5m: 6.25,
  cacheRead: 0.5,
  output: 25
});
