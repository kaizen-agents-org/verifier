import { describe, expect, it } from "vitest";
import { fixtureRunExitCode } from "../src/eval/fixture-run.js";
import type { FixtureCaseResult, FixtureRunResult } from "../src/eval/fixture-run.js";

function fixtureResult(passed: boolean, knownGap = false): FixtureCaseResult {
  return {
    id: "fixture",
    kind: "seeded",
    description: "fixture",
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
      harnessErrors,
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
});
