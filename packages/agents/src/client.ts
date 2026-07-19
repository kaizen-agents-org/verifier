import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { AgentUsage } from "./cost.js";
import { INTENT_AGENT_CONFIG } from "./config.js";
import {
  INTENT_EXTRACTOR_SYSTEM_PROMPT,
  buildIntentExtractorPrompt,
  type IntentSourceInput
} from "./intent/prompt.js";
import { IntentExtractionSchema, type IntentExtraction } from "./intent/schema.js";
import { runStructuredAgent } from "./structured-output.js";

export interface IntentExtractorInput {
  sources: IntentSourceInput[];
  diffSummary: string;
}

export interface IntentExtractorRequest {
  model: string;
  effort: typeof INTENT_AGENT_CONFIG.effort;
  max_tokens: number;
  system: Array<{
    type: "text";
    text: string;
    cache_control: { type: "ephemeral" };
  }>;
  messages: Array<{ role: "user"; content: string }>;
  output_config: {
    format: ReturnType<typeof zodOutputFormat<typeof IntentExtractionSchema>>;
  };
}

export interface IntentExtractorResponse {
  parsed_output: IntentExtraction | null;
  stop_reason: string | null;
  usage: AgentUsage;
}

export type IntentExtractorTransport = (
  request: IntentExtractorRequest
) => Promise<IntentExtractorResponse>;

export interface ExtractIntentOptions {
  transport?: IntentExtractorTransport;
  client?: Anthropic;
}

export interface ExtractIntentResult {
  extraction: IntentExtraction;
  usage: AgentUsage;
}

export async function extractIntent(
  input: IntentExtractorInput,
  options: ExtractIntentOptions = {}
): Promise<ExtractIntentResult> {
  const transport = options.transport ?? createAnthropicTransport(options.client ?? new Anthropic());
  const request = createIntentExtractorRequest(input);
  const result = await runStructuredAgent({
    agentName: "Intent extractor",
    request,
    transport,
    schema: IntentExtractionSchema,
    maxSchemaRetries: INTENT_AGENT_CONFIG.maxSchemaRetries
  });
  return { extraction: result.output, usage: result.usage };
}

export function createIntentExtractorRequest(input: IntentExtractorInput): IntentExtractorRequest {
  return {
    model: INTENT_AGENT_CONFIG.model,
    effort: INTENT_AGENT_CONFIG.effort,
    max_tokens: INTENT_AGENT_CONFIG.maxTokens,
    system: [
      {
        type: "text",
        text: INTENT_EXTRACTOR_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" }
      }
    ],
    messages: [
      {
        role: "user",
        content: buildIntentExtractorPrompt(input.sources, input.diffSummary)
      }
    ],
    output_config: {
      format: zodOutputFormat(IntentExtractionSchema)
    }
  };
}

export function createAnthropicTransport(client: Anthropic): IntentExtractorTransport {
  return async (request) => {
    const response = await client.messages.parse(request);
    return {
      parsed_output: response.parsed_output,
      stop_reason: response.stop_reason,
      usage: response.usage
    };
  };
}
