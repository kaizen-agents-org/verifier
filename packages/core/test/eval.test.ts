import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { calculateEvalMetrics, compareVerdict } from "../src/eval/metrics.js";
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

  it("requires confidence bounds for verdict agreement", () => {
    const metrics = calculateEvalMetrics([
      {
        id: "confidence-regression",
        kind: "golden",
        description: "Correct verdict with unexpectedly high confidence.",
        passed: false,
        failures: ["expected confidence <= 50, got 82"],
        actual: {
          verdict: "needs_context",
          risk: "medium",
          confidence: 82,
          mustFixCount: 0,
          shouldFixCount: 1
        },
        expected: {
          verdict: "needs_context",
          confidenceMax: 50
        }
      }
    ]);

    expect(metrics.verdictAgreement).toBe(0);
  });

  it("calculates false-positive rate from surplus findings", () => {
    const metrics = calculateEvalMetrics([
      {
        id: "bug-with-extra-finding",
        kind: "seeded",
        description: "Expected bug findings plus one extra finding.",
        passed: false,
        failures: ["expected at most 0 false-positive finding(s), got 1"],
        actual: {
          verdict: "block_pr",
          risk: "high",
          confidence: 88,
          mustFixCount: 2,
          shouldFixCount: 1
        },
        expected: {
          verdict: "block_pr",
          mustFixMin: 2,
          maxFalsePositives: 0
        }
      },
      {
        id: "clean-with-two-extra-findings",
        kind: "golden",
        description: "Clean case with two unexpected findings.",
        passed: false,
        failures: ["expected at most 0 false-positive finding(s), got 2"],
        actual: {
          verdict: "open_pr_with_warning",
          risk: "medium",
          confidence: 72,
          mustFixCount: 0,
          shouldFixCount: 2
        },
        expected: {
          verdict: "open_pr",
          maxFalsePositives: 0
        }
      }
    ]);

    expect(metrics.falsePositiveRate).toBe(0.6);
  });

  it("reports the corpus path when a case cannot be parsed", async () => {
    const corpusDir = await mkdtemp(join(tmpdir(), "verifier-eval-"));
    const casePath = join(corpusDir, "invalid.json");
    await writeFile(casePath, "{", "utf8");

    await expect(runEval({ corpusDir })).rejects.toThrow(`Failed to load eval case ${casePath}`);
  });
});
