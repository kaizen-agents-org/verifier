import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assessFixturePolicy,
  calculateFixtureContentSha256,
  calculateFixtureMetrics,
  FixtureEvalPolicySchema,
  fixtureRunExitCode,
  loadPreviousFixtureEvalPolicy,
  runFixtureEval
} from "../src/eval/fixture-run.js";
import type {
  FixtureCaseResult,
  FixtureEvalPolicy,
  FixtureRunResult
} from "../src/eval/fixture-run.js";

const execFileAsync = promisify(execFile);
const FIXTURE_CONTENT_SHA256 = "a".repeat(64);

function fixtureResult(passed: boolean, knownGap = false): FixtureCaseResult {
  return {
    id: "fixture",
    kind: "seeded",
    description: "fixture",
    fixtureContentSha256: FIXTURE_CONTENT_SHA256,
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
    adjustedMetrics: {
      recall: 0,
      verdictAgreement: 0
    },
    acceptedDebt: {
      activeCount: 0,
      retiredCount: 0,
      activeCaseIds: [],
      retiredCaseIds: []
    },
    gateFailures: [],
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
    fixtureContentSha256: FIXTURE_CONTENT_SHA256,
    groundTruth: { defect },
    passed,
    failures: passed ? [] : ["unexpected verdict"],
    actual: { verdict: actualVerdict, confidence: 60 },
    expected: { verdict: expectedVerdict }
  };
}

function policy(
  knownGapDebt: FixtureEvalPolicy["knownGapDebt"],
  baseline = {
    rawRecallMin: 0,
    rawVerdictAgreementMin: 0,
    debtCaseIds: knownGapDebt.map((debt) => debt.caseId)
  }
): FixtureEvalPolicy {
  return { baseline, knownGapDebt };
}

describe("fixture eval exit status", () => {
  it("includes confidence calibration in verdict agreement", () => {
    const result = fixtureResult(false);
    result.actual = { verdict: "conditional", confidence: 60 };
    result.expected = { verdict: "conditional", confidenceMin: 70, knownGap: false };

    expect(calculateFixtureMetrics([result], 0)).toMatchObject({
      failedCases: 1,
      verdictAgreement: 0
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

  it("fails when the fixture policy gate fails", () => {
    const result = runResult([fixtureResult(false, true)]);
    result.gateFailures.push("known gap fixture has no approved debt");

    expect(fixtureRunExitCode(result)).toBe(1);
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

describe("fixture known-gap debt policy", () => {
  const debtMetadata = {
    reason: "Requires semantic reproduction.",
    owner: "kaizen-agents-org/verifier",
    followUp: "https://github.com/kaizen-agents-org/verifier/issues/81",
    introducedOn: "2026-07-22",
    groundTruthDefect: true as const,
    expectedVerdicts: ["conditional"] as const,
    fixtureContentSha256: FIXTURE_CONTENT_SHA256
  };

  it("rejects impossible calendar dates and duplicate debt records", () => {
    const duplicateDebt = {
      caseId: "duplicate-gap",
      ...debtMetadata,
      status: "active" as const
    };
    const invalid = FixtureEvalPolicySchema.safeParse({
      baseline: {
        rawRecallMin: 0,
        rawVerdictAgreementMin: 0,
        debtCaseIds: ["duplicate-gap"]
      },
      knownGapDebt: [
        { ...duplicateDebt, introducedOn: "2026-02-31" },
        duplicateDebt
      ]
    });

    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["knownGapDebt", 0, "introducedOn"],
            message: "must be a valid calendar date (YYYY-MM-DD)"
          }),
          expect.objectContaining({
            path: ["knownGapDebt", 1, "caseId"],
            message: "knownGapDebt caseId must be unique"
          })
        ])
      );
    }
  });

  it("reports baseline/ledger mismatches and duplicate assessment records", () => {
    const debt = {
      caseId: "unregistered-gap",
      ...debtMetadata,
      status: "active" as const
    };
    const duplicateFixture = metricFixture(
      "duplicate-fixture",
      true,
      "mergeable",
      "conditional"
    );
    const result = assessFixturePolicy(
      [duplicateFixture, duplicateFixture],
      calculateFixtureMetrics([duplicateFixture, duplicateFixture], 0),
      {
        baseline: {
          rawRecallMin: 0,
          rawVerdictAgreementMin: 0,
          debtCaseIds: ["missing-record"]
        },
        knownGapDebt: [debt, debt]
      }
    );

    expect(result.gateFailures).toEqual(
      expect.arrayContaining([
        "duplicate fixture case id: duplicate-fixture",
        "duplicate known-gap debt record: unregistered-gap",
        "registered known-gap debt missing-record has no debt record",
        "known-gap debt unregistered-gap is not registered in baseline debtCaseIds"
      ])
    );
  });

  it("derives adjusted metric denominators from the assessed results", () => {
    const falseNegative = metricFixture(
      "approved-gap",
      true,
      "mergeable",
      "conditional"
    );
    falseNegative.expected.knownGap = true;
    const mismatchedMetrics = {
      ...calculateFixtureMetrics([falseNegative], 0),
      totalCases: 0,
      defectCases: 0
    };

    const result = assessFixturePolicy(
      [falseNegative],
      mismatchedMetrics,
      policy([{ caseId: "approved-gap", ...debtMetadata, status: "active" }])
    );

    expect(result.adjustedMetrics).toEqual({ recall: 1, verdictAgreement: 1 });
  });

  it("rejects unauthorized known-gap growth", () => {
    const falseNegative = metricFixture("new-gap", true, "mergeable", "conditional");
    falseNegative.expected.knownGap = true;
    const metrics = calculateFixtureMetrics([falseNegative], 0);

    const result = assessFixturePolicy([falseNegative], metrics, policy([]));

    expect(result.gateFailures).toContain("known gap new-gap has no approved active debt record");
  });

  it("reports approved debt separately without hiding raw metrics", () => {
    const falseNegative = metricFixture("approved-gap", true, "mergeable", "conditional");
    falseNegative.expected.knownGap = true;
    const metrics = calculateFixtureMetrics([falseNegative], 0);

    const result = assessFixturePolicy(
      [falseNegative],
      metrics,
      policy([{ caseId: "approved-gap", ...debtMetadata, status: "active" }])
    );

    expect(metrics).toMatchObject({ recall: 0, verdictAgreement: 0 });
    expect(result.adjustedMetrics).toEqual({ recall: 1, verdictAgreement: 1 });
    expect(result.acceptedDebt).toMatchObject({
      activeCount: 1,
      retiredCount: 0,
      activeCaseIds: ["approved-gap"]
    });
    expect(result.gateFailures).toEqual([]);
  });

  it("accepts debt repayment only when the retained case passes", () => {
    const repaired = metricFixture("repaired-gap", true, "conditional", "conditional");
    const metrics = calculateFixtureMetrics([repaired], 0);

    const result = assessFixturePolicy(
      [repaired],
      metrics,
      policy([
        {
          caseId: "repaired-gap",
          ...debtMetadata,
          status: "retired",
          retiredOn: "2026-07-30"
        }
      ])
    );

    expect(result.acceptedDebt).toMatchObject({
      activeCount: 0,
      retiredCount: 1,
      retiredCaseIds: ["repaired-gap"]
    });
    expect(result.adjustedMetrics).toEqual({ recall: 1, verdictAgreement: 1 });
    expect(result.gateFailures).toEqual([]);
  });

  it("rejects retirement by deleting the case or only removing knownGap", () => {
    const stillFailing = metricFixture("repaid-gap", true, "mergeable", "conditional");
    const debt: FixtureEvalPolicy["knownGapDebt"][number] = {
      caseId: "repaid-gap",
      ...debtMetadata,
      status: "retired",
      retiredOn: "2026-07-30"
    };

    const missing = assessFixturePolicy([], calculateFixtureMetrics([], 0), policy([debt]));
    const relabeled = assessFixturePolicy(
      [stillFailing],
      calculateFixtureMetrics([stillFailing], 0),
      policy([debt])
    );

    expect(missing.gateFailures).toContain(
      "retired known-gap debt repaid-gap must retain its fixture case"
    );
    expect(relabeled.gateFailures).toContain(
      "retired known-gap debt repaid-gap does not pass"
    );
  });

  it("rejects deleting both a known-gap fixture and its debt record", () => {
    const previousDebt: FixtureEvalPolicy["knownGapDebt"][number] = {
      caseId: "deleted-gap",
      ...debtMetadata,
      status: "active"
    };
    const result = assessFixturePolicy(
      [],
      calculateFixtureMetrics([], 0),
      policy([]),
      policy([previousDebt])
    );

    expect(result.gateFailures).toContain(
      "previously registered known-gap debt deleted-gap was deleted"
    );
    expect(result.gateFailures).toContain(
      "previous known-gap debt record deleted-gap was deleted"
    );
  });

  it("rejects retirement by weakening the defect labels", () => {
    const weakened = metricFixture("weakened-gap", false, "mergeable", "mergeable");
    const debt: FixtureEvalPolicy["knownGapDebt"][number] = {
      caseId: "weakened-gap",
      ...debtMetadata,
      status: "retired",
      retiredOn: "2026-07-30"
    };

    const result = assessFixturePolicy(
      [weakened],
      calculateFixtureMetrics([weakened], 0),
      policy([debt])
    );

    expect(weakened.passed).toBe(true);
    expect(result.gateFailures).toContain(
      "known-gap debt weakened-gap changed its ground-truth defect label"
    );
    expect(result.gateFailures).toContain(
      "known-gap debt weakened-gap changed its expected verdicts"
    );
    expect(result.gateFailures).toContain(
      "retired known-gap debt weakened-gap is not detected with its original expected verdict"
    );
  });

  it("rejects retirement after replacing the original fixture contents", () => {
    const replacement = metricFixture(
      "replaced-gap",
      true,
      "conditional",
      "conditional"
    );
    replacement.fixtureContentSha256 = "b".repeat(64);
    const previousDebt: FixtureEvalPolicy["knownGapDebt"][number] = {
      caseId: "replaced-gap",
      ...debtMetadata,
      status: "active"
    };
    const retiredDebt: FixtureEvalPolicy["knownGapDebt"][number] = {
      ...previousDebt,
      status: "retired",
      retiredOn: "2026-07-30"
    };

    const pinned = assessFixturePolicy(
      [replacement],
      calculateFixtureMetrics([replacement], 0),
      policy([retiredDebt]),
      policy([previousDebt])
    );
    const rewrittenDebt = {
      ...retiredDebt,
      fixtureContentSha256: replacement.fixtureContentSha256
    };
    const rewritten = assessFixturePolicy(
      [replacement],
      calculateFixtureMetrics([replacement], 0),
      policy([rewrittenDebt]),
      policy([previousDebt])
    );

    expect(replacement.passed).toBe(true);
    expect(pinned.gateFailures).toContain(
      "known-gap debt replaced-gap changed its fixture contents"
    );
    expect(rewritten.gateFailures).toContain(
      "known-gap debt replaced-gap changed immutable metadata"
    );
  });

  it("fingerprints fixture metadata and repository contents", async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "verifier-fixture-hash-"));
    try {
      await mkdir(join(fixtureDir, "repo"));
      await writeFile(
        join(fixtureDir, "case.json"),
        '{"id":"fixture","expected":{"verdict":"conditional","knownGap":true}}\n'
      );
      await writeFile(join(fixtureDir, "repo", "source.ts"), "export const value = 1;\n");
      const original = await calculateFixtureContentSha256(fixtureDir);

      await writeFile(
        join(fixtureDir, "case.json"),
        '{"id":"fixture","expected":{"verdict":"conditional","knownGap":false}}\n'
      );
      const retired = await calculateFixtureContentSha256(fixtureDir);
      await writeFile(join(fixtureDir, "repo", "source.ts"), "export const value = 2;\n");
      const changed = await calculateFixtureContentSha256(fixtureDir);

      expect(original).toMatch(/^[0-9a-f]{64}$/);
      expect(retired).toBe(original);
      expect(changed).toMatch(/^[0-9a-f]{64}$/);
      expect(changed).not.toBe(original);

      await writeFile(join(fixtureDir, "repo", "artifact.bin"), Buffer.from([0x80]));
      const firstBinary = await calculateFixtureContentSha256(fixtureDir);
      await writeFile(join(fixtureDir, "repo", "artifact.bin"), Buffer.from([0x81]));
      const secondBinary = await calculateFixtureContentSha256(fixtureDir);
      expect(secondBinary).not.toBe(firstBinary);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("rejects reactivation and retirement date changes", () => {
    const previousDebt: FixtureEvalPolicy["knownGapDebt"][number] = {
      caseId: "retired-gap",
      ...debtMetadata,
      status: "retired",
      retiredOn: "2026-07-30"
    };
    const reactivatedDebt: FixtureEvalPolicy["knownGapDebt"][number] = {
      caseId: "retired-gap",
      ...debtMetadata,
      status: "active"
    };
    const changedRetirement: FixtureEvalPolicy["knownGapDebt"][number] = {
      ...previousDebt,
      retiredOn: "2026-07-31"
    };

    const reactivated = assessFixturePolicy(
      [],
      calculateFixtureMetrics([], 0),
      policy([reactivatedDebt]),
      policy([previousDebt])
    );
    const changed = assessFixturePolicy(
      [],
      calculateFixtureMetrics([], 0),
      policy([changedRetirement]),
      policy([previousDebt])
    );

    expect(reactivated.gateFailures).toContain(
      "retired known-gap debt retired-gap was reactivated"
    );
    expect(changed.gateFailures).toContain(
      "retired known-gap debt retired-gap changed retiredOn"
    );
  });

  it("rejects raw recall and verdict-agreement regressions", () => {
    const falseNegative = metricFixture("regression", true, "mergeable", "conditional");
    const metrics = calculateFixtureMetrics([falseNegative], 0);

    const result = assessFixturePolicy(
      [falseNegative],
      metrics,
      policy([], { rawRecallMin: 0.75, rawVerdictAgreementMin: 0.8, debtCaseIds: [] })
    );

    expect(result.gateFailures).toContain("raw recall 0.0000 fell below baseline 0.7500");
    expect(result.gateFailures).toContain(
      "raw verdict agreement 0.0000 fell below baseline 0.8000"
    );
  });

  it("rejects lowering committed raw metric baselines", () => {
    const result = assessFixturePolicy(
      [],
      calculateFixtureMetrics([], 0),
      policy([], { rawRecallMin: 0.5, rawVerdictAgreementMin: 0.6, debtCaseIds: [] }),
      policy([], { rawRecallMin: 0.75, rawVerdictAgreementMin: 0.8, debtCaseIds: [] })
    );

    expect(result.gateFailures).toContain(
      "raw recall baseline 0.5000 was lowered from 0.7500"
    );
    expect(result.gateFailures).toContain(
      "raw verdict agreement baseline 0.6000 was lowered from 0.8000"
    );
  });

  it("uses the HEAD policy to reject local rollback when BASE_SHA is absent", async () => {
    const repository = await mkdtemp(join(tmpdir(), "verifier-dirty-policy-"));
    const policyPath = join(repository, "fixtures", "eval-policy.json");
    const committedPolicy = policy([], {
      rawRecallMin: 0.75,
      rawVerdictAgreementMin: 0.8,
      debtCaseIds: []
    });
    const loweredPolicy = policy([]);
    try {
      await mkdir(dirname(policyPath), { recursive: true });
      await writeFile(policyPath, `${JSON.stringify(committedPolicy, null, 2)}\n`);
      await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repository });
      await execFileAsync("git", ["add", "."], { cwd: repository });
      await execFileAsync(
        "git",
        [
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "user.name=verifier-fixture",
          "commit",
          "-q",
          "-m",
          "committed policy"
        ],
        { cwd: repository }
      );
      await writeFile(policyPath, `${JSON.stringify(loweredPolicy, null, 2)}\n`);

      const previousPolicy = await loadPreviousFixtureEvalPolicy(undefined, repository);
      const result = assessFixturePolicy(
        [],
        calculateFixtureMetrics([], 0),
        loweredPolicy,
        previousPolicy
      );

      expect(previousPolicy).toEqual(committedPolicy);
      expect(result.gateFailures).toContain(
        "raw recall baseline 0.0000 was lowered from 0.7500"
      );
      expect(result.gateFailures).toContain(
        "raw verdict agreement baseline 0.0000 was lowered from 0.8000"
      );
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("derives a legacy fingerprint from the branch base when BASE_SHA is absent", async () => {
    const repository = await mkdtemp(join(tmpdir(), "verifier-legacy-policy-"));
    const caseDir = join(
      repository,
      "fixtures",
      "corpus",
      "seeded",
      "legacy-gap"
    );
    try {
      await mkdir(join(caseDir, "repo"), { recursive: true });
      await writeFile(
        join(caseDir, "case.json"),
        `${JSON.stringify({
          id: "legacy-gap",
          kind: "seeded",
          description: "legacy debt",
          groundTruth: { defect: true },
          expected: { verdict: "conditional", knownGap: true },
          setup: { baseDir: "repo", verifyCommands: [] },
          timeoutMinutes: 1
        })}\n`
      );
      await writeFile(join(caseDir, "repo", "source.ts"), "export const value = 1;\n");
      await writeFile(join(caseDir, "bug.patch"), "legacy defect\n");
      await writeFile(
        join(repository, "fixtures", "eval-policy.json"),
        `${JSON.stringify({
          baseline: {
            rawRecallMin: 0,
            rawVerdictAgreementMin: 0,
            debtCaseIds: ["legacy-gap"]
          },
          knownGapDebt: [
            {
              caseId: "legacy-gap",
              reason: debtMetadata.reason,
              owner: debtMetadata.owner,
              followUp: debtMetadata.followUp,
              introducedOn: debtMetadata.introducedOn,
              groundTruthDefect: true,
              expectedVerdicts: ["conditional"],
              status: "active"
            }
          ]
        }, null, 2)}\n`
      );
      await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repository });
      await execFileAsync("git", ["add", "."], { cwd: repository });
      await execFileAsync(
        "git",
        [
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "user.name=verifier-fixture",
          "commit",
          "-q",
          "-m",
          "legacy policy"
        ],
        { cwd: repository }
      );
      const { stdout: baseSha } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: repository
      });
      await execFileAsync(
        "git",
        ["update-ref", "refs/remotes/origin/main", baseSha.trim()],
        { cwd: repository }
      );

      await writeFile(join(caseDir, "repo", "source.ts"), "export const value = 2;\n");
      const replacementHash = await calculateFixtureContentSha256(caseDir);
      const replacement = metricFixture(
        "legacy-gap",
        true,
        "conditional",
        "conditional"
      );
      replacement.fixtureContentSha256 = replacementHash;
      const rewrittenDebt: FixtureEvalPolicy["knownGapDebt"][number] = {
        ...debtMetadata,
        caseId: "legacy-gap",
        fixtureContentSha256: replacementHash,
        groundTruthDefect: true,
        expectedVerdicts: ["conditional"],
        status: "retired",
        retiredOn: "2026-07-31"
      };
      await writeFile(
        join(repository, "fixtures", "eval-policy.json"),
        `${JSON.stringify(policy([rewrittenDebt]), null, 2)}\n`
      );
      await execFileAsync("git", ["add", "."], { cwd: repository });
      await execFileAsync(
        "git",
        [
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "user.name=verifier-fixture",
          "commit",
          "-q",
          "-m",
          "replace fixture"
        ],
        { cwd: repository }
      );

      const previousPolicy = await loadPreviousFixtureEvalPolicy(undefined, repository);

      const result = assessFixturePolicy(
        [replacement],
        calculateFixtureMetrics([replacement], 0),
        policy([rewrittenDebt]),
        previousPolicy
      );

      expect(previousPolicy.knownGapDebt[0]?.fixtureContentSha256).not.toBe(
        replacementHash
      );
      expect(result.gateFailures).toContain(
        "known-gap debt legacy-gap changed immutable metadata"
      );
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
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
