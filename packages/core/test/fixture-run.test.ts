import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { calculateFixtureMetrics, fixtureRunExitCode, runFixtureEval } from "../src/eval/fixture-run.js";
import type { FixtureCaseResult, FixtureRunResult } from "../src/eval/fixture-run.js";

function fixtureResult(passed: boolean, knownGap = false): FixtureCaseResult {
  return {
    id: "fixture",
    kind: "seeded",
    description: "fixture",
    groundTruth: { defect: true },
    passed,
    failures: passed ? [] : ["unexpected verdict"],
    actual: { verdict: "conditional", confidence: 60 },
    expected: { verdict: "mergeable", knownGap }
  };
}

function runResult(cases: FixtureCaseResult[], harnessErrors = 0): FixtureRunResult {
  const failedCases = cases.filter((fixtureCase) => !fixtureCase.passed).length;
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    corpusDir: "/fixtures",
    metrics: {
      totalCases: cases.length,
      passedCases: cases.length - failedCases,
      failedCases,
      knownGapFailures: cases.filter(
        (fixtureCase) => !fixtureCase.passed && fixtureCase.expected.knownGap
      ).length,
      unexpectedFailures: cases.filter(
        (fixtureCase) => !fixtureCase.passed && !fixtureCase.expected.knownGap
      ).length,
      harnessErrors,
      defectCases: cases.length,
      cleanCases: 0,
      recall: 0,
      fpRate: 0,
      falsePositiveCases: 0,
      verdictAgreement: 0,
      byKind: {
        seeded: { total: cases.length, passed: cases.length - failedCases, failed: failedCases },
        golden: { total: 0, passed: 0, failed: 0 }
      }
    },
    cases,
    harnessErrorDetails: []
  };
}

function metricFixture(
  id: string,
  defect: boolean,
  actualVerdict: FixtureCaseResult["actual"]["verdict"],
  expectedVerdict: NonNullable<FixtureCaseResult["expected"]["verdict"]>
): FixtureCaseResult {
  const passed = actualVerdict === expectedVerdict;
  return {
    id,
    kind: "seeded",
    description: id,
    groundTruth: { defect },
    passed,
    failures: passed ? [] : ["unexpected verdict"],
    actual: { verdict: actualVerdict, confidence: 60 },
    expected: { verdict: expectedVerdict }
  };
}

describe("fixture eval exit status", () => {
  it("succeeds for passing cases and known-gap failures", () => {
    const cases = [fixtureResult(true), fixtureResult(false, true)];

    expect(fixtureRunExitCode(runResult(cases))).toBe(0);
    expect(runResult(cases).metrics.failedCases).toBe(1);
  });

  it("fails for an unmarked failure", () => {
    expect(fixtureRunExitCode(runResult([fixtureResult(false)]))).toBe(1);
  });

  it("fails when an ordinary failure accompanies a known gap", () => {
    expect(fixtureRunExitCode(runResult([fixtureResult(false, true), fixtureResult(false)]))).toBe(1);
  });

  it("fails on harness errors even when all case failures are known gaps", () => {
    expect(fixtureRunExitCode(runResult([fixtureResult(false, true)], 1))).toBe(1);
  });

  it("reports accepted gaps separately from unexpected failures", () => {
    const result = runResult([
      fixtureResult(true),
      fixtureResult(false, true),
      fixtureResult(false)
    ]);

    expect(result.metrics.knownGapFailures).toBe(1);
    expect(result.metrics.unexpectedFailures).toBe(1);
  });
});

describe("fixture metrics", () => {
  it("computes case-level recall and false-positive rate from mixed outcomes", () => {
    const result = calculateFixtureMetrics([
      metricFixture("true-positive", true, "not_mergeable", "not_mergeable"),
      metricFixture("false-negative", true, "mergeable", "not_mergeable"),
      metricFixture("false-positive", false, "conditional", "mergeable"),
      metricFixture("true-negative", false, "mergeable", "mergeable")
    ], 0);

    expect(result.defectCases).toBe(2);
    expect(result.cleanCases).toBe(2);
    expect(result.recall).toBe(0.5);
    expect(result.fpRate).toBe(0.5);
    expect(result.falsePositiveCases).toBe(1);
    expect(result.verdictAgreement).toBe(0.5);
  });
});

describe("golden fixture replay", () => {
  it("uses a vendored replay without cloning the provenance repository", async () => {
    const corpusDir = await mkdtemp(join(tmpdir(), "verifier-golden-test-"));
    const caseDir = join(corpusDir, "golden", "gp-offline");
    const repoDir = join(caseDir, "repo");

    try {
      await mkdir(repoDir, { recursive: true });
      await writeFile(join(repoDir, "value.txt"), "before\n", "utf8");
      await writeFile(
        join(caseDir, "change.patch"),
        [
          "diff --git a/value.txt b/value.txt",
          "index 90be1f3..3bd1f0e 100644",
          "--- a/value.txt",
          "+++ b/value.txt",
          "@@ -1 +1 @@",
          "-before",
          "+after",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        join(caseDir, "case.json"),
        `${JSON.stringify({
          id: "gp-offline",
          kind: "golden",
          description: "offline replay",
          groundTruth: { defect: false },
          intent: { text: "Change before to after." },
          expected: { verdict: "mergeable" },
          golden: {
            repoUrl: "https://example.invalid/unreachable.git",
            baseSha: "1".repeat(40),
            headSha: "2".repeat(40),
            labelSource: "https://example.invalid/review/1",
            replay: { baseDir: "repo", patch: "change.patch" },
            verifyCommands: ["node -e \"console.log('all tests passed')\""]
          }
        }, null, 2)}\n`,
        "utf8"
      );

      const result = await runFixtureEval({ corpusDir });

      expect(result.metrics.harnessErrors).toBe(0);
      expect(result.metrics.passedCases).toBe(1);
      expect(result.cases[0]?.actual.verdict).toBe("mergeable");

      const casePath = join(caseDir, "case.json");
      const fixture = JSON.parse(await readFile(casePath, "utf8")) as {
        expected: { verdict: string; confidenceMax?: number };
      };
      fixture.expected.confidenceMax = 0;
      await writeFile(casePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
      const confidenceMismatch = await runFixtureEval({ corpusDir });
      expect(confidenceMismatch.metrics.failedCases).toBe(1);
      expect(confidenceMismatch.metrics.verdictAgreement).toBe(1);
    } finally {
      await rm(corpusDir, { recursive: true, force: true });
    }
  });
});
