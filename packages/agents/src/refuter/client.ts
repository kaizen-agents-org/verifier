import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Finding } from "@verifier/core";
import { REFUTER_AGENT_CONFIG } from "../config.js";
import type { AgentUsage } from "../cost.js";
import { runStructuredAgent, type StructuredAgentResponse } from "../structured-output.js";
import { buildRefuterPrompt, REFUTER_SYSTEM_PROMPT } from "./prompt.js";
import { RefuterOutputSchema, type RefuterOutput } from "./schema.js";

export interface RefuterInput {
  finding: Finding;
  relatedCode: string;
}

export interface RefuterRequest {
  model: string;
  effort: typeof REFUTER_AGENT_CONFIG.effort;
  max_tokens: number;
  system: Array<{ type: "text"; text: string }>;
  messages: Array<{ role: "user"; content: string }>;
  output_config: {
    format: ReturnType<typeof zodOutputFormat<typeof RefuterOutputSchema>>;
  };
}

export type RefuterResponse = StructuredAgentResponse<RefuterOutput>;
export type RefuterTransport = (request: RefuterRequest) => Promise<RefuterResponse>;

export async function refuteFinding(
  input: RefuterInput,
  options: { transport?: RefuterTransport; client?: Anthropic } = {}
): Promise<{ refutation: RefuterOutput; usage: AgentUsage }> {
  const transport = options.transport ?? createRefuterTransport(options.client ?? new Anthropic());
  const result = await runStructuredAgent({
    agentName: "Refuter",
    request: createRefuterRequest(input),
    transport,
    schema: RefuterOutputSchema,
    maxSchemaRetries: REFUTER_AGENT_CONFIG.maxSchemaRetries
  });
  return { refutation: result.output, usage: result.usage };
}

export function createRefuterRequest(input: RefuterInput): RefuterRequest {
  return {
    model: REFUTER_AGENT_CONFIG.model,
    effort: REFUTER_AGENT_CONFIG.effort,
    max_tokens: REFUTER_AGENT_CONFIG.maxTokens,
    system: [{ type: "text", text: REFUTER_SYSTEM_PROMPT }],
    messages: [
      { role: "user", content: buildRefuterPrompt(input.finding, input.relatedCode) }
    ],
    output_config: { format: zodOutputFormat(RefuterOutputSchema) }
  };
}

export function createRefuterTransport(client: Anthropic): RefuterTransport {
  return async (request) => {
    const response = await client.messages.parse(request);
    return {
      parsed_output: response.parsed_output,
      stop_reason: response.stop_reason,
      usage: response.usage
    };
  };
}
