import type { Claim, TargetType } from "@verifier/core";

export const SCENARIO_GENERATOR_SYSTEM_PROMPT = `You generate bounded runtime observation scenarios for a verifier.
Return only the required structured output. Never invent claim IDs.
For CLI targets, exec.command must be one of the caller-provided logical command IDs; it is not shell text.
For API targets, request.path must be a relative path beginning with one slash. Never include an origin.
Use request.expect for API expectations. Keep every scenario minimal and deterministic.`;

export function buildScenarioGeneratorPrompt(
  diff: string,
  targetType: TargetType,
  claims: Claim[],
  allowedCommandIds: string[]
): string {
  return JSON.stringify({
    diff,
    targetType,
    claims: claims.map(({ id, statement, priority, plannedChecks }) => ({
      id,
      statement,
      priority,
      plannedChecks
    })),
    allowedCommandIds
  });
}
