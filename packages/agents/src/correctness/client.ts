import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Claim } from "@verifier/core";
import type { AgentUsage } from "../cost.js";
import { CORRECTNESS_AGENT_CONFIG } from "../config.js";
import { runStructuredAgent, type StructuredAgentResponse } from "../structured-output.js";
import { buildCorrectnessPrompt, CORRECTNESS_SYSTEM_PROMPT } from "./prompt.js";
import { CorrectnessReviewSchema, type CorrectnessReview } from "./schema.js";

export interface CorrectnessReviewInput {
  diff: string;
  context: string;
  claims: Claim[];
}

export interface CorrectnessReviewRequest {
  model: string;
  max_tokens: number;
  system: Array<{
    type: "text";
    text: string;
    cache_control: { type: "ephemeral" };
  }>;
  messages: Array<{ role: "user"; content: string }>;
  output_config: {
    effort: typeof CORRECTNESS_AGENT_CONFIG.effort;
    format: ReturnType<typeof zodOutputFormat<typeof CorrectnessReviewSchema>>;
  };
}

export type CorrectnessReviewResponse = StructuredAgentResponse<CorrectnessReview>;
export type CorrectnessReviewTransport = (
  request: CorrectnessReviewRequest
) => Promise<CorrectnessReviewResponse>;

export async function reviewCorrectness(
  input: CorrectnessReviewInput,
  options: { transport?: CorrectnessReviewTransport; client?: Anthropic } = {}
): Promise<{ review: CorrectnessReview; usage: AgentUsage }> {
  const transport = options.transport ?? createCorrectnessTransport(options.client ?? new Anthropic());
  const result = await runStructuredAgent({
    agentName: "Correctness lens",
    request: createCorrectnessReviewRequest(input),
    transport,
    schema: CorrectnessReviewSchema,
    maxSchemaRetries: CORRECTNESS_AGENT_CONFIG.maxSchemaRetries
  });
  return { review: result.output, usage: result.usage };
}

export function createCorrectnessReviewRequest(
  input: CorrectnessReviewInput
): CorrectnessReviewRequest {
  return {
    model: CORRECTNESS_AGENT_CONFIG.model,
    max_tokens: CORRECTNESS_AGENT_CONFIG.maxTokens,
    system: [
      {
        type: "text",
        text: CORRECTNESS_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" }
      }
    ],
    messages: [
      { role: "user", content: buildCorrectnessPrompt(input.diff, input.context, input.claims) }
    ],
    output_config: {
      effort: CORRECTNESS_AGENT_CONFIG.effort,
      format: zodOutputFormat(CorrectnessReviewSchema)
    }
  };
}

export function createCorrectnessTransport(client: Anthropic): CorrectnessReviewTransport {
  return async (request) => {
    const response = await client.messages.parse(request);
    return {
      parsed_output: response.parsed_output,
      stop_reason: response.stop_reason,
      usage: response.usage
    };
  };
}
