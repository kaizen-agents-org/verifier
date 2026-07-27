import { UnsupportedStepError, type Scenario } from "@verifier/probe-sdk";

export function assertSupportedWaitCondition(
  step: Extract<Scenario["steps"][number], { op: "wait" }>
): void {
  if (step.until !== undefined) {
    throw new UnsupportedStepError(step, "API driver does not support wait-until conditions.");
  }
}
