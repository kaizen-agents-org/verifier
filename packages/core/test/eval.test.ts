import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { calculateEvalMetrics, compareThresholds, compareVerdict } from "../src/eval/metrics.js";
import { runEval } from "../src/eval/run.js";
import type { MinimalVerdict } from "../src/types.js";

describe("eval harness", () => {
  it("passes the committed verifier corpus", async () => {
    const result = await runEval();

    expect(result.metrics.failedCases).toBe(0);
    expect(result.thresholds).toEqual({
      verdictAgreementMin: 0.9,
      falsePositiveRateMax: 0.1
    });
    expect(result.thresholdFailures).toEqual([]);
    expect(result.metrics.verdictAgreement).toBe(1);
    expect(result.metrics.falsePositiveRate).toBe(0);
    expect(result.metrics.byKind.seeded.total).toBeGreaterThan(0);
    expect(result.metrics.byKind.golden.total).toBeGreaterThan(0);
    expect(result.cases.find((testCase) => testCase.id === "sb-009-unexplained-diff-needs-context")).toMatchObject({
      passed: true,
      actual: {
        verdict: "needs_context",
        risk: "medium"
      },
      expected: {
        confidenceMax: 50
      }
    });
    expect(result.cases.map((testCase) => testCase.actual.verdict)).toEqual(
      expect.arrayContaining(["open_pr", "open_pr_with_warning", "block_pr", "needs_context"])
    );
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

  it("reports threshold failures for metrics outside the release gate", () => {
    const metrics = calculateEvalMetrics([
      {
        id: "clean-with-extra-finding",
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

    expect(
      compareThresholds(metrics, {
        verdictAgreementMin: 0.9,
        falsePositiveRateMax: 0.1
      })
    ).toEqual([
      "verdictAgreement 0.0000 is below minimum 0.9000",
      "falsePositiveRate 1.0000 exceeds maximum 0.1000"
    ]);
  });

  it("applies threshold comparisons to run results", async () => {
    const corpusDir = await mkdtemp(join(tmpdir(), "verifier-eval-"));
    await writeFile(
      join(corpusDir, "wrong-verdict.json"),
      `${JSON.stringify(
        {
          id: "wrong-verdict",
          kind: "golden",
          description: "Clean evidence with an intentionally wrong expected verdict.",
          input: {
            task: "Document how to run the verifier eval harness.",
            diff: "diff --git a/README.md b/README.md\n+Run pnpm eval.",
            verifyLogs: "pnpm test passed\npnpm typecheck passed",
            builderReport: "documentation updated and checks passed"
          },
          expected: {
            verdict: "block_pr"
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const result = await runEval({ corpusDir });

    expect(result.metrics.failedCases).toBe(1);
    expect(result.metrics.verdictAgreement).toBe(0);
    expect(result.thresholdFailures).toEqual([
      "verdictAgreement 0.0000 is below minimum 0.9000"
    ]);
  });

  it("uses expected finding maxima before counting false positives", () => {
    const verdict: MinimalVerdict = {
      schemaVersion: 1,
      verdict: "block_pr",
      must_fix: [
        { source: "verify_logs", message: "Verification failed." },
        { source: "diff", message: "Security-sensitive change." }
      ],
      should_fix: [{ source: "builder_report", message: "Reviewer should inspect auth." }],
      confidence: 78,
      risk: "high",
      summary: "Block PR with 2 must_fix item(s); risk is high."
    };

    expect(
      compareVerdict(
        {
          verdict: "block_pr",
          mustFixMin: 1,
          mustFixMax: 2,
          shouldFixMax: 1,
          maxFalsePositives: 0
        },
        verdict
      )
    ).toEqual([]);
  });

  it("reports the corpus path when a case cannot be parsed", async () => {
    const corpusDir = await mkdtemp(join(tmpdir(), "verifier-eval-"));
    const casePath = join(corpusDir, "invalid.json");
    await writeFile(casePath, "{", "utf8");

    await expect(runEval({ corpusDir })).rejects.toThrow(`Failed to load eval case ${casePath}`);
  });
});
