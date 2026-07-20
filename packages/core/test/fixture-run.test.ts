import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { calculateFixtureMetrics, fixtureRunExitCode, runFixtureEval } from "../src/eval/fixture-run.js";
import type { FixtureCaseResult, FixtureRunResult } from "../src/eval/fixture-run.js";

const execFileAsync = promisify(execFile);

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

describe("fixture eval exit status", () => {
  it("keeps verdict agreement independent from confidence calibration failures", () => {
    const result = fixtureResult(false);
    result.actual = { verdict: "conditional", confidence: 60 };
    result.expected = { verdict: "conditional", confidenceMin: 70, knownGap: false };

    expect(calculateFixtureMetrics([result], 0)).toMatchObject({
      failedCases: 1,
      verdictAgreement: 1
    });
  });

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
    } finally {
      await rm(corpusDir, { recursive: true, force: true });
    }
  });

  it("clones a local repository path when replay data is unavailable", async () => {
    const corpusDir = await mkdtemp(join(tmpdir(), "verifier-golden-local-test-"));
    const sourceDir = join(corpusDir, "source");
    const caseDir = join(corpusDir, "golden", "gp-local");

    try {
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, "value.txt"), "before\n", "utf8");
      await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: sourceDir });
      await execFileAsync("git", ["add", "value.txt"], { cwd: sourceDir });
      await execFileAsync("git", ["-c", "user.name=Verifier", "-c", "user.email=verifier@example.com", "commit", "-q", "-m", "base"], { cwd: sourceDir });
      const { stdout: sha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: sourceDir });
      await mkdir(caseDir, { recursive: true });
      await writeFile(
        join(caseDir, "case.json"),
        `${JSON.stringify({
          id: "gp-local",
          kind: "golden",
          description: "local clone source",
          groundTruth: { defect: false },
          intent: { text: "Keep the checked-in value." },
          expected: { verdictAnyOf: ["mergeable", "conditional", "not_mergeable", "inconclusive"] },
          golden: {
            repoUrl: sourceDir,
            baseSha: sha.trim(),
            headSha: sha.trim(),
            labelSource: "https://example.invalid/review/1",
            verifyCommands: ["node -e \"console.log('all tests passed')\""]
          }
        }, null, 2)}\n`,
        "utf8"
      );

      const result = await runFixtureEval({ corpusDir: join(corpusDir, "golden") });

      expect(result.metrics.harnessErrors).toBe(0);
      expect(result.metrics.passedCases).toBe(1);
    } finally {
      await rm(corpusDir, { recursive: true, force: true });
    }
  });
});
