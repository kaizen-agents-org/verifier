import { z } from "zod/v4";
import type { AgentUsage } from "./cost.js";

export interface StructuredAgentResponse<T> {
  parsed_output: T | null;
  stop_reason: string | null;
  usage: AgentUsage;
}

export class StructuredOutputSchemaError extends Error {
  constructor(
    message: string,
    readonly usage: AgentUsage
  ) {
    super(message);
    this.name = "StructuredOutputSchemaError";
  }
}

export async function runStructuredAgent<Request, Output>(options: {
  agentName: string;
  request: Request;
  transport: (request: Request) => Promise<StructuredAgentResponse<Output>>;
  schema: z.ZodType<Output>;
  maxSchemaRetries: number;
}): Promise<{ output: Output; usage: AgentUsage }> {
  let usage = emptyUsage();

  for (let attempt = 0; ; attempt += 1) {
    let response: StructuredAgentResponse<Output>;
    try {
      response = await options.transport(options.request);
    } catch (error) {
      if (attempt < options.maxSchemaRetries && isStructuredOutputError(error)) continue;
      if (isStructuredOutputError(error)) {
        throw new StructuredOutputSchemaError(
          `${options.agentName} returned invalid structured output after retries.`,
          usage
        );
      }
      throw error;
    }
    usage = addUsage(usage, response.usage);

    if (response.stop_reason === "refusal") {
      throw new Error(`${options.agentName} request was refused by the model.`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error(`${options.agentName} response exceeded the configured token limit.`);
    }
    if (response.parsed_output === null) {
      throw new Error(`${options.agentName} returned no structured output.`);
    }

    const parsed = options.schema.safeParse(response.parsed_output);
    if (parsed.success) return { output: parsed.data, usage };
    if (attempt >= options.maxSchemaRetries) {
      throw new StructuredOutputSchemaError(
        `${options.agentName} returned output that violates the schema after retries.`,
        usage
      );
    }
  }
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
