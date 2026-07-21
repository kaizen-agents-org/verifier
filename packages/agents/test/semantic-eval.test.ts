import { describe, expect, it } from "vitest";
import {
  calculateSemanticMetrics,
  compareSemanticThresholds,
  runSemanticEval,
  semanticEvalExitCode
} from "../src/eval/run.js";

describe("semantic refutation eval", () => {
  it("runs the full corpus with refutation on and off", async () => {
    const result = await runSemanticEval({ mode: "full" });

    expect(result.refutationOff).toMatchObject({ recall: 1, fpRate: 0.3333 });
    expect(result.refutationOn).toMatchObject({ recall: 1, fpRate: 0, verdictAgreement: 1 });
    expect(result.recallImprovement).toBeGreaterThan(0);
    expect(result.thresholdFailures).toEqual([]);
    expect(result.cases).toHaveLength(14);
  });

  it("uses only sb-001, sb-003, and sb-008 for smoke", async () => {
    const result = await runSemanticEval({ mode: "smoke" });
    expect(result.cases.map((item) => item.id).sort()).toEqual([
      "sb-001-authz-missing",
      "sb-003-regression-breaks-test",
      "sb-008-clean-refactor"
    ]);
  });

  it("fails the release gate when a threshold is missed", () => {
    const metrics = calculateSemanticMetrics(
      [{ defect: true, findingsOff: 0, findingsOn: 0 }],
      "findingsOn"
    );
    expect(
      compareSemanticThresholds(metrics, { recall: 0.85, fpRate: 0.1, verdictAgreement: 0.9 })
    ).toEqual([
      "recall 0.0000 is below minimum 0.8500",
      "verdictAgreement 0.0000 is below minimum 0.9000"
    ]);
  });

  it("returns a failing process status when refutation-off metrics miss the gate", async () => {
    const result = await runSemanticEval({ mode: "full", gateMode: "off" });
    expect(result.thresholdFailures).toContain("fpRate 0.3333 exceeds maximum 0.1000");
    expect(semanticEvalExitCode(result)).toBe(1);
  });
});
