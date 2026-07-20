import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Claim, TargetType } from "@verifier/core";
import type { AgentUsage } from "../cost.js";
import { SCENARIO_AGENT_CONFIG } from "../config.js";
import { runStructuredAgent, type StructuredAgentResponse } from "../structured-output.js";
import {
  buildScenarioGeneratorPrompt,
  SCENARIO_GENERATOR_SYSTEM_PROMPT
} from "./prompt.js";
import { ScenarioGenerationSchema, type ScenarioGeneration } from "./schema.js";

export interface ScenarioGeneratorInput {
  diff: string;
  targetType: TargetType;
  claims: Claim[];
  allowedCommandIds?: string[];
}

export interface ScenarioGeneratorRequest {
  model: string;
  max_tokens: number;
  system: Array<{
    type: "text";
    text: string;
    cache_control: { type: "ephemeral" };
  }>;
  messages: Array<{ role: "user"; content: string }>;
  output_config: {
    effort: typeof SCENARIO_AGENT_CONFIG.effort;
    format: ReturnType<typeof zodOutputFormat<typeof ScenarioGenerationSchema>>;
  };
}

export type ScenarioGeneratorResponse = StructuredAgentResponse<ScenarioGeneration>;
export type ScenarioGeneratorTransport = (
  request: ScenarioGeneratorRequest
) => Promise<ScenarioGeneratorResponse>;

export async function generateScenarios(
  input: ScenarioGeneratorInput,
  options: { transport?: ScenarioGeneratorTransport; client?: Anthropic } = {}
): Promise<{ generation: ScenarioGeneration; usage: AgentUsage }> {
  const transport = options.transport ?? createScenarioGeneratorTransport(options.client ?? new Anthropic());
  const result = await runStructuredAgent({
    agentName: "Scenario generator",
    request: createScenarioGeneratorRequest(input),
    transport,
    schema: ScenarioGenerationSchema,
    maxSchemaRetries: SCENARIO_AGENT_CONFIG.maxSchemaRetries
  });
  validateScenarioAuthority(result.output, input);
  return { generation: result.output, usage: result.usage };
}

export function createScenarioGeneratorRequest(
  input: ScenarioGeneratorInput
): ScenarioGeneratorRequest {
  return {
    model: SCENARIO_AGENT_CONFIG.model,
    max_tokens: SCENARIO_AGENT_CONFIG.maxTokens,
    system: [
      {
        type: "text",
        text: SCENARIO_GENERATOR_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" }
      }
    ],
    messages: [
      {
        role: "user",
        content: buildScenarioGeneratorPrompt(
          input.diff,
          input.targetType,
          input.claims,
          input.allowedCommandIds ?? []
        )
      }
    ],
    output_config: {
      effort: SCENARIO_AGENT_CONFIG.effort,
      format: zodOutputFormat(ScenarioGenerationSchema)
    }
  };
}

export function createScenarioGeneratorTransport(client: Anthropic): ScenarioGeneratorTransport {
  return async (request) => {
    const response = await client.messages.parse(request);
    return {
      parsed_output: response.parsed_output,
      stop_reason: response.stop_reason,
      usage: response.usage
    };
  };
}

function validateScenarioAuthority(
  generation: ScenarioGeneration,
  input: ScenarioGeneratorInput
): void {
  const claimIds = new Set(input.claims.map(({ id }) => id));
  const commandIds = new Set(input.allowedCommandIds ?? []);
  const scenarioIds = new Set<string>();
  for (const scenario of generation.scenarios) {
    if (scenarioIds.has(scenario.id)) {
      throw new Error(`Scenario generator returned duplicate scenario ID: ${scenario.id}`);
    }
    scenarioIds.add(scenario.id);
    for (const claimId of scenario.claimIds) {
      if (!claimIds.has(claimId)) throw new Error(`Scenario generator returned unknown claim ID: ${claimId}`);
    }
    for (const step of scenario.steps) {
      const supported = input.targetType === "cli"
        ? step.op === "exec" || step.op === "wait"
        : input.targetType === "api"
          ? step.op === "request" || step.op === "wait"
          : true;
      if (!supported) {
        throw new Error(`Scenario generator returned unsupported ${step.op} step for ${input.targetType}`);
      }
      if (step.op === "exec" && !commandIds.has(step.command)) {
        throw new Error(`Scenario generator returned unauthorized command ID: ${step.command}`);
      }
      if (step.op === "request" && (!step.path.startsWith("/") || step.path.startsWith("//"))) {
        throw new Error(`Scenario generator returned unsafe request path: ${step.path}`);
      }
    }
  }
}
