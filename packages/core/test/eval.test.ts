import { describe, expect, it } from "vitest";
import { compareVerdict } from "../src/eval/metrics.js";
import { runEval } from "../src/eval/run.js";
import type { MinimalVerdict } from "../src/types.js";

describe("eval harness", () => {
  it("passes the committed verifier corpus", async () => {
    const result = await runEval();

    expect(result.metrics.failedCases).toBe(0);
    expect(result.metrics.verdictAgreement).toBe(1);
    expect(result.metrics.falsePositiveRate).toBe(0);
    expect(result.metrics.byKind.seeded.total).toBeGreaterThan(0);
    expect(result.metrics.byKind.golden.total).toBeGreaterThan(0);
  });

  it("does not count expected bug findings as false positives", () => {
    const verdict: MinimalVerdict = {
      schemaVersion: 1,
      verdict: "block_pr",
      must_fix: [{ source: "verify_logs", message: "Verification failed." }],
      should_fix: [],
      confidence: 78,
      risk: "high",
      summary: "Block PR with 1 must_fix item(s); risk is high."
    };

    expect(
      compareVerdict(
        {
          verdict: "block_pr",
          mustFixMin: 1,
          maxFalsePositives: 0
        },
        verdict
      )
    ).toEqual([]);
  });
});
