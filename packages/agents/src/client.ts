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
  let usage = emptyUsage();

  for (let attempt = 0; ; attempt += 1) {
    let response: IntentExtractorResponse;
    try {
      response = await transport(request);
    } catch (error) {
      if (attempt < INTENT_AGENT_CONFIG.maxSchemaRetries && isStructuredOutputError(error)) {
        continue;
      }
      throw error;
    }
    usage = addUsage(usage, response.usage);

    if (response.stop_reason === "refusal") {
      throw new Error("Intent extractor request was refused by the model.");
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error("Intent extractor response exceeded the configured token limit.");
    }
    if (response.parsed_output === null) {
      throw new Error("Intent extractor returned no structured output.");
    }

    const parsed = IntentExtractionSchema.safeParse(response.parsed_output);
    if (parsed.success) {
      return { extraction: parsed.data, usage };
    }
    if (attempt >= INTENT_AGENT_CONFIG.maxSchemaRetries) {
      throw parsed.error;
    }
  }
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

function isStructuredOutputError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Failed to parse structured output");
}

function emptyUsage(): AgentUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  };
}

function addUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    cache_creation_input_tokens:
      (left.cache_creation_input_tokens ?? 0) + (right.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      (left.cache_read_input_tokens ?? 0) + (right.cache_read_input_tokens ?? 0)
  };
}
