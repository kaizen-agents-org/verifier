import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { runCheck } from "../check.js";
import { FinalVerdictKindSchema } from "../types.js";
import type { FinalVerdictKind } from "../types.js";

const execFileAsync = promisify(execFile);

const NEUTRAL_BASE_COMMIT_MESSAGE = "base";
const NEUTRAL_HEAD_COMMIT_MESSAGE = "apply changes";
const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FIXTURE_EVAL_POLICY_REPO_PATH = "fixtures/eval-policy.json";
const FIXTURE_EVAL_POLICY_BOOTSTRAP_BASE_SHA =
  "04bea41333cdf444b2cb4a3f19ea6c532a3fc45f";

const FixtureExpectedSchema = z
  .object({
    verdict: FinalVerdictKindSchema.optional(),
    verdictAnyOf: z.array(FinalVerdictKindSchema).min(1).optional(),
    confidenceMin: z.number().int().min(0).max(100).optional(),
    confidenceMax: z.number().int().min(0).max(100).optional(),
    knownGap: z.boolean().default(false)
  })
  .refine((expected) => !(expected.verdict && expected.verdictAnyOf), {
    message: "expected.verdict and expected.verdictAnyOf are mutually exclusive"
  })
  .refine((expected) => expected.verdict !== undefined || expected.verdictAnyOf !== undefined, {
    message: "expected.verdict or expected.verdictAnyOf is required"
  });

const FixtureCaseSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["seeded", "golden"]),
  description: z.string().min(1),
  groundTruth: z.object({ defect: z.boolean() }),
  intent: z.object({ text: z.string().min(1) }).optional(),
  expected: FixtureExpectedSchema,
  setup: z
    .object({
      baseDir: z.string().min(1),
      patch: z.string().min(1).optional(),
      verifyCommands: z.array(z.string()).default([])
    })
    .optional(),
  golden: z
    .object({
      repoUrl: z.string().trim().min(1),
      baseSha: z.string().regex(FULL_GIT_SHA_PATTERN),
      headSha: z.string().regex(FULL_GIT_SHA_PATTERN),
      labelSource: z.string().url(),
      replay: z
        .object({
          baseDir: z.string().min(1),
          patch: z.string().min(1)
        })
        .optional(),
      verifyCommands: z.array(z.string()).default([])
    })
    .optional(),
  timeoutMinutes: z.number().positive().default(15)
});

const IsoDateSchema = z
  .string()
  .regex(ISO_DATE_PATTERN)
  .refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    },
    { message: "must be a valid calendar date (YYYY-MM-DD)" }
  );

const KnownGapDebtBaseSchema = z.object({
  caseId: z.string().min(1),
  reason: z.string().min(1),
  owner: z.string().min(1),
  followUp: z.string().min(1),
  introducedOn: IsoDateSchema,
  groundTruthDefect: z.literal(true),
  expectedVerdicts: z.array(FinalVerdictKindSchema).min(1),
  fixtureContentSha256: z.string().regex(SHA256_PATTERN)
});

export const FixtureEvalPolicySchema = z.object({
  baseline: z.object({
    rawRecallMin: z.number().min(0).max(1),
    rawVerdictAgreementMin: z.number().min(0).max(1),
    debtCaseIds: z.array(z.string().min(1))
  }),
  knownGapDebt: z.array(
    z.discriminatedUnion("status", [
      KnownGapDebtBaseSchema.extend({ status: z.literal("active") }).strict(),
      KnownGapDebtBaseSchema.extend({
        status: z.literal("retired"),
        retiredOn: IsoDateSchema
      }).strict()
    ])
  )
}).superRefine((policy, context) => {
  const registeredDebtIds = new Set<string>();
  policy.baseline.debtCaseIds.forEach((caseId, index) => {
    if (registeredDebtIds.has(caseId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "debtCaseIds must be unique",
        path: ["baseline", "debtCaseIds", index]
      });
    }
    registeredDebtIds.add(caseId);
  });
  const knownGapDebtIds = new Set<string>();
  policy.knownGapDebt.forEach((debt, index) => {
    if (knownGapDebtIds.has(debt.caseId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "knownGapDebt caseId must be unique",
        path: ["knownGapDebt", index, "caseId"]
      });
    }
    knownGapDebtIds.add(debt.caseId);
    if (new Set(debt.expectedVerdicts).size !== debt.expectedVerdicts.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expectedVerdicts must be unique",
        path: ["knownGapDebt", index, "expectedVerdicts"]
      });
    }
    if (debt.expectedVerdicts.some((verdict) => !isDefectDetected(verdict))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "known-gap debt expectedVerdicts must all detect a defect",
        path: ["knownGapDebt", index, "expectedVerdicts"]
      });
    }
    if (debt.status === "retired" && debt.retiredOn < debt.introducedOn) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "retiredOn must not precede introducedOn",
        path: ["knownGapDebt", index, "retiredOn"]
      });
    }
  });
});

export type FixtureCase = z.infer<typeof FixtureCaseSchema>;
export type FixtureEvalPolicy = z.infer<typeof FixtureEvalPolicySchema>;

const BOOTSTRAP_FIXTURE_EVAL_POLICY: FixtureEvalPolicy = {
  baseline: {
    rawRecallMin: 0,
    rawVerdictAgreementMin: 0,
    debtCaseIds: [
      "sb-005-file-handle-leak",
      "sb-007-multibyte-cache-collision",
      "sb-010-intent-implementation-mismatch"
    ]
  },
  knownGapDebt: [
    {
      caseId: "sb-005-file-handle-leak",
      reason: "Detecting error-path resource leaks requires the planned Stage 4 reproduction capability.",
      owner: "kaizen-agents-org/verifier",
      followUp: "https://github.com/kaizen-agents-org/verifier/issues/81",
      introducedOn: "2026-07-22",
      groundTruthDefect: true,
      expectedVerdicts: ["conditional"],
      fixtureContentSha256: "ce9cfe808cdc2f0e234d3ffdf5be0bad8f16684da431bea8087b6479dfde2354",
      status: "active"
    },
    {
      caseId: "sb-007-multibyte-cache-collision",
      reason: "Detecting multibyte cache-key collisions requires the planned Stage 4 reproduction capability.",
      owner: "kaizen-agents-org/verifier",
      followUp: "https://github.com/kaizen-agents-org/verifier/issues/81",
      introducedOn: "2026-07-22",
      groundTruthDefect: true,
      expectedVerdicts: ["conditional"],
      fixtureContentSha256: "2de3491b07294230bb06c3138e141a843d7643dd1f8b58c161654c709ca07f74",
      status: "active"
    },
    {
      caseId: "sb-010-intent-implementation-mismatch",
      reason: "Detecting semantic intent mismatches requires primary-source claim extraction and diff comparison.",
      owner: "kaizen-agents-org/verifier",
      followUp: "https://github.com/kaizen-agents-org/verifier/issues/81",
      introducedOn: "2026-07-22",
      groundTruthDefect: true,
      expectedVerdicts: ["conditional", "not_mergeable"],
      fixtureContentSha256: "38114258e5f030c9f199026845ec17cb42e3f2ff7b8d17abf5e716c60dd3f85b",
      status: "active"
    }
  ]
};

export interface FixtureCaseResult {
  id: string;
  kind: "seeded" | "golden";
  description: string;
  fixtureContentSha256: string;
  groundTruth: { defect: boolean };
  passed: boolean;
  failures: string[];
  actual: {
    verdict: FinalVerdictKind;
    confidence: number;
  };
  expected: z.infer<typeof FixtureExpectedSchema>;
}

export interface FixtureMetrics {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  knownGapFailures: number;
  unexpectedFailures: number;
  harnessErrors: number;
  defectCases: number;
  cleanCases: number;
  recall: number;
  fpRate: number;
  falsePositiveCases: number;
  verdictAgreement: number;
  byKind: Record<"seeded" | "golden", { total: number; passed: number; failed: number }>;
}

export interface FixtureRunResult {
  generatedAt: string;
  corpusDir: string;
  metrics: FixtureMetrics;
  adjustedMetrics: {
    recall: number;
    verdictAgreement: number;
  };
  acceptedDebt: {
    activeCount: number;
    retiredCount: number;
    activeCaseIds: string[];
    retiredCaseIds: string[];
  };
  gateFailures: string[];
  cases: FixtureCaseResult[];
  harnessErrorDetails: Array<{ id: string; message: string }>;
}

export interface RunFixtureEvalOptions {
  corpusDir?: string;
  outputFile?: string;
  policyFile?: string | false;
}

export function fixtureRunExitCode(result: FixtureRunResult): 0 | 1 {
  const hasUnexpectedFailure = result.cases.some(
    (fixtureCase) => !fixtureCase.passed && fixtureCase.expected.knownGap !== true
  );
  return result.metrics.harnessErrors === 0 &&
    !hasUnexpectedFailure &&
    result.gateFailures.length === 0
    ? 0
    : 1;
}

export async function runFixtureEval(options: RunFixtureEvalOptions = {}): Promise<FixtureRunResult> {
  const corpusDir = resolve(options.corpusDir ?? defaultFixtureCorpusDir());
  const casePaths = await findCaseFiles(corpusDir);
  if (casePaths.length === 0) {
    throw new Error(`No fixture case.json files found under ${corpusDir}`);
  }

  const results: FixtureCaseResult[] = [];
  const harnessErrorDetails: Array<{ id: string; message: string }> = [];

  for (const casePath of casePaths.sort()) {
    const fixtureCase = await loadFixtureCase(casePath);
    try {
      const caseDir = dirname(casePath);
      const fixtureContentSha256 = await calculateFixtureContentSha256(caseDir);
      results.push(await runFixtureCase(fixtureCase, caseDir, fixtureContentSha256));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      harnessErrorDetails.push({ id: fixtureCase.id, message });
    }
  }

  const metrics = calculateFixtureMetrics(results, harnessErrorDetails.length);
  const customCorpus = options.corpusDir !== undefined;
  const policy = await loadFixtureEvalPolicy(options.policyFile, customCorpus);
  const usesDefaultPolicyFile =
    options.policyFile !== false &&
    resolve(options.policyFile ?? defaultFixtureEvalPolicyFile()) ===
      defaultFixtureEvalPolicyFile();
  const previousPolicy =
    policy && usesDefaultPolicyFile && !customCorpus
      ? await loadPreviousFixtureEvalPolicy(process.env.BASE_SHA)
      : undefined;
  const policyAssessment = policy
    ? assessFixturePolicy(results, metrics, policy, previousPolicy)
    : emptyPolicyAssessment(metrics);
  const runResult: FixtureRunResult = {
    generatedAt: new Date().toISOString(),
    corpusDir: options.corpusDir ? corpusDir : "fixtures/corpus",
    metrics,
    adjustedMetrics: policyAssessment.adjustedMetrics,
    acceptedDebt: policyAssessment.acceptedDebt,
    gateFailures: policyAssessment.gateFailures,
    cases: results,
    harnessErrorDetails
  };

  if (options.outputFile) {
    await writeFile(resolve(options.outputFile), `${JSON.stringify(runResult, null, 2)}\n`, "utf8");
  }

  return runResult;
}

async function runFixtureCase(
  fixtureCase: FixtureCase,
  caseDir: string,
  fixtureContentSha256: string
): Promise<FixtureCaseResult> {
  const workspace = await mkdtemp(join(tmpdir(), "verifier-fixture-"));
  try {
    const { baseSha, verifyCommands } = await prepareWorkspace(fixtureCase, caseDir, workspace);
    const checkResult = await runCheck({
      task: fixtureCase.intent?.text ?? "",
      workspace,
      base: baseSha,
      verifyCommands,
      verifyTimeoutMs: fixtureCase.timeoutMinutes * 60_000
    });

    const actual = {
      verdict: checkResult.verdict.final_verdict ?? "inconclusive",
      confidence: checkResult.verdict.confidence
    };
    const failures = compareFixtureVerdict(fixtureCase.expected, actual);

    return {
      id: fixtureCase.id,
      kind: fixtureCase.kind,
      description: fixtureCase.description,
      fixtureContentSha256,
      groundTruth: fixtureCase.groundTruth,
      passed: failures.length === 0,
      failures,
      actual,
      expected: fixtureCase.expected
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function prepareWorkspace(
  fixtureCase: FixtureCase,
  caseDir: string,
  workspace: string
): Promise<{ baseSha: string; verifyCommands: string[] }> {
  if (fixtureCase.kind === "seeded") {
    if (!fixtureCase.setup) {
      throw new Error(`seeded case ${fixtureCase.id} is missing setup.baseDir`);
    }
    return prepareSeededWorkspace(fixtureCase.setup, caseDir, workspace);
  }

  if (!fixtureCase.golden) {
    throw new Error(`golden case ${fixtureCase.id} is missing golden.repoUrl/baseSha/headSha`);
  }
  return prepareGoldenWorkspace(fixtureCase.golden, caseDir, workspace);
}

async function prepareSeededWorkspace(
  setup: NonNullable<FixtureCase["setup"]>,
  caseDir: string,
  workspace: string
): Promise<{ baseSha: string; verifyCommands: string[] }> {
  const baseDir = resolve(caseDir, setup.baseDir);
  await copyDirectory(baseDir, workspace);
  await git(workspace, ["init", "-q", "-b", "main"]);
  await git(workspace, ["add", "-A"]);
  await gitCommit(workspace, NEUTRAL_BASE_COMMIT_MESSAGE);
  const { stdout: baseSha } = await git(workspace, ["rev-parse", "HEAD"]);

  if (setup.patch) {
    const patchPath = resolve(caseDir, setup.patch);
    await git(workspace, ["apply", patchPath]);
    await git(workspace, ["add", "-A"]);
    await gitCommit(workspace, NEUTRAL_HEAD_COMMIT_MESSAGE);
  }

  return { baseSha: baseSha.trim(), verifyCommands: setup.verifyCommands };
}

async function prepareGoldenWorkspace(
  golden: NonNullable<FixtureCase["golden"]>,
  caseDir: string,
  workspace: string
): Promise<{ baseSha: string; verifyCommands: string[] }> {
  if (golden.replay) {
    return prepareReplayWorkspace(golden.replay, golden.verifyCommands, caseDir, workspace);
  }

  await git(workspace, ["clone", "-q", golden.repoUrl, "."]);
  await git(workspace, ["checkout", "-q", golden.headSha]);
  return { baseSha: golden.baseSha, verifyCommands: golden.verifyCommands };
}

async function prepareReplayWorkspace(
  replay: NonNullable<NonNullable<FixtureCase["golden"]>["replay"]>,
  verifyCommands: string[],
  caseDir: string,
  workspace: string
): Promise<{ baseSha: string; verifyCommands: string[] }> {
  const setup = {
    baseDir: replay.baseDir,
    patch: replay.patch,
    verifyCommands
  };
  return prepareSeededWorkspace(setup, caseDir, workspace);
}

function compareFixtureVerdict(
  expected: z.infer<typeof FixtureExpectedSchema>,
  actual: { verdict: FinalVerdictKind; confidence: number }
): string[] {
  const failures: string[] = [];
  const expectedVerdicts = expected.verdictAnyOf ?? (expected.verdict ? [expected.verdict] : []);

  if (expectedVerdicts.length > 0 && !expectedVerdicts.includes(actual.verdict)) {
    failures.push(`expected verdict ${expectedVerdicts.join(" or ")}, got ${actual.verdict}`);
  }
  if (expected.confidenceMin !== undefined && actual.confidence < expected.confidenceMin) {
    failures.push(`expected confidence >= ${expected.confidenceMin}, got ${actual.confidence}`);
  }
  if (expected.confidenceMax !== undefined && actual.confidence > expected.confidenceMax) {
    failures.push(`expected confidence <= ${expected.confidenceMax}, got ${actual.confidence}`);
  }

  return failures;
}

export function calculateFixtureMetrics(results: FixtureCaseResult[], harnessErrors: number): FixtureMetrics {
  const byKind: FixtureMetrics["byKind"] = {
    seeded: { total: 0, passed: 0, failed: 0 },
    golden: { total: 0, passed: 0, failed: 0 }
  };
  let verdictMatches = 0;
  let knownGapFailures = 0;
  let detectedDefects = 0;
  let falsePositiveCases = 0;

  for (const result of results) {
    const bucket = byKind[result.kind];
    bucket.total += 1;
    if (result.passed) bucket.passed += 1;
    else {
      bucket.failed += 1;
      if (result.expected.knownGap) knownGapFailures += 1;
    }

    if (compareFixtureVerdict(result.expected, result.actual).length === 0) {
      verdictMatches += 1;
    }
    if (result.groundTruth.defect && isDefectDetected(result.actual.verdict)) {
      detectedDefects += 1;
    }
    if (!result.groundTruth.defect && isFalsePositiveVerdict(result)) {
      falsePositiveCases += 1;
    }
  }

  const defectCases = results.filter((result) => result.groundTruth.defect).length;
  const cleanCases = results.length - defectCases;

  return {
    totalCases: results.length,
    passedCases: results.filter((result) => result.passed).length,
    failedCases: results.filter((result) => !result.passed).length,
    knownGapFailures,
    unexpectedFailures: results.filter(
      (result) => !result.passed && result.expected.knownGap !== true
    ).length,
    harnessErrors,
    defectCases,
    cleanCases,
    recall: ratio(detectedDefects, defectCases),
    fpRate: ratio(falsePositiveCases, cleanCases),
    falsePositiveCases,
    verdictAgreement: ratio(verdictMatches, results.length),
    byKind
  };
}

export function assessFixturePolicy(
  results: FixtureCaseResult[],
  metrics: FixtureMetrics,
  policy: FixtureEvalPolicy,
  previousPolicy?: FixtureEvalPolicy
): Pick<FixtureRunResult, "adjustedMetrics" | "acceptedDebt" | "gateFailures"> {
  const gateFailures: string[] = [];
  const casesById = new Map<string, FixtureCaseResult>();
  const duplicateCaseIds = new Set<string>();
  for (const result of results) {
    if (casesById.has(result.id)) duplicateCaseIds.add(result.id);
    casesById.set(result.id, result);
  }
  for (const caseId of duplicateCaseIds) {
    gateFailures.push(`duplicate fixture case id: ${caseId}`);
  }

  const debtByCaseId = new Map<string, FixtureEvalPolicy["knownGapDebt"][number]>();
  const duplicateDebtIds = new Set<string>();
  for (const debt of policy.knownGapDebt) {
    if (debtByCaseId.has(debt.caseId)) duplicateDebtIds.add(debt.caseId);
    debtByCaseId.set(debt.caseId, debt);
  }
  for (const caseId of duplicateDebtIds) {
    gateFailures.push(`duplicate known-gap debt record: ${caseId}`);
  }

  const registeredDebtIds = new Set(policy.baseline.debtCaseIds);
  for (const caseId of registeredDebtIds) {
    if (!debtByCaseId.has(caseId)) {
      gateFailures.push(`registered known-gap debt ${caseId} has no debt record`);
    }
  }
  for (const debt of policy.knownGapDebt) {
    if (!registeredDebtIds.has(debt.caseId)) {
      gateFailures.push(`known-gap debt ${debt.caseId} is not registered in baseline debtCaseIds`);
    }
  }
  if (previousPolicy) {
    compareDebtLedgers(policy, previousPolicy, gateFailures);
  }

  const activeDebts = policy.knownGapDebt.filter((debt) => debt.status === "active");
  const retiredDebts = policy.knownGapDebt.filter((debt) => debt.status === "retired");
  const activeDebtIds = new Set(activeDebts.map((debt) => debt.caseId));

  for (const result of results) {
    if (result.expected.knownGap && !activeDebtIds.has(result.id)) {
      gateFailures.push(`known gap ${result.id} has no approved active debt record`);
    }
  }

  for (const debt of activeDebts) {
    const result = casesById.get(debt.caseId);
    if (!result) {
      gateFailures.push(`active known-gap debt ${debt.caseId} has no fixture case`);
      continue;
    }
    if (!result.expected.knownGap) {
      gateFailures.push(`active known-gap debt ${debt.caseId} is no longer marked knownGap`);
    }
    validateDebtFixtureSnapshot(debt, result, gateFailures);
    if (result.passed) {
      gateFailures.push(`active known-gap debt ${debt.caseId} now passes and must be retired`);
    }
    if (!result.groundTruth.defect || isDefectDetected(result.actual.verdict)) {
      gateFailures.push(`active known-gap debt ${debt.caseId} is not a false negative`);
    }
  }

  for (const debt of retiredDebts) {
    const result = casesById.get(debt.caseId);
    if (!result) {
      gateFailures.push(`retired known-gap debt ${debt.caseId} must retain its fixture case`);
      continue;
    }
    if (result.expected.knownGap) {
      gateFailures.push(`retired known-gap debt ${debt.caseId} is still marked knownGap`);
    }
    validateDebtFixtureSnapshot(debt, result, gateFailures);
    if (!result.passed) {
      gateFailures.push(`retired known-gap debt ${debt.caseId} does not pass`);
    }
    if (
      !isDefectDetected(result.actual.verdict) ||
      !debt.expectedVerdicts.includes(result.actual.verdict)
    ) {
      gateFailures.push(
        `retired known-gap debt ${debt.caseId} is not detected with its original expected verdict`
      );
    }
  }

  if (metrics.recall < policy.baseline.rawRecallMin) {
    gateFailures.push(
      `raw recall ${formatRate(metrics.recall)} fell below baseline ${formatRate(
        policy.baseline.rawRecallMin
      )}`
    );
  }
  if (metrics.verdictAgreement < policy.baseline.rawVerdictAgreementMin) {
    gateFailures.push(
      `raw verdict agreement ${formatRate(
        metrics.verdictAgreement
      )} fell below baseline ${formatRate(policy.baseline.rawVerdictAgreementMin)}`
    );
  }

  const activeFalseNegatives = results.filter(
    (result) =>
      activeDebtIds.has(result.id) &&
      result.groundTruth.defect &&
      !isDefectDetected(result.actual.verdict)
  ).length;
  const activeDisagreements = results.filter(
    (result) =>
      activeDebtIds.has(result.id) &&
      compareFixtureVerdict(result.expected, result.actual).length > 0
  ).length;
  const detectedDefects = results.filter(
    (result) => result.groundTruth.defect && isDefectDetected(result.actual.verdict)
  ).length;
  const verdictMatches = results.filter(
    (result) => compareFixtureVerdict(result.expected, result.actual).length === 0
  ).length;
  const defectCases = results.filter((result) => result.groundTruth.defect).length;

  return {
    adjustedMetrics: {
      recall: ratio(detectedDefects + activeFalseNegatives, defectCases),
      verdictAgreement: ratio(verdictMatches + activeDisagreements, results.length)
    },
    acceptedDebt: {
      activeCount: activeDebts.length,
      retiredCount: retiredDebts.length,
      activeCaseIds: activeDebts.map((debt) => debt.caseId).sort(),
      retiredCaseIds: retiredDebts.map((debt) => debt.caseId).sort()
    },
    gateFailures
  };
}

function compareDebtLedgers(
  policy: FixtureEvalPolicy,
  previousPolicy: FixtureEvalPolicy,
  gateFailures: string[]
): void {
  if (policy.baseline.rawRecallMin < previousPolicy.baseline.rawRecallMin) {
    gateFailures.push(
      `raw recall baseline ${formatRate(
        policy.baseline.rawRecallMin
      )} was lowered from ${formatRate(previousPolicy.baseline.rawRecallMin)}`
    );
  }
  if (
    policy.baseline.rawVerdictAgreementMin <
    previousPolicy.baseline.rawVerdictAgreementMin
  ) {
    gateFailures.push(
      `raw verdict agreement baseline ${formatRate(
        policy.baseline.rawVerdictAgreementMin
      )} was lowered from ${formatRate(previousPolicy.baseline.rawVerdictAgreementMin)}`
    );
  }

  const currentRegisteredIds = new Set(policy.baseline.debtCaseIds);
  for (const caseId of previousPolicy.baseline.debtCaseIds) {
    if (!currentRegisteredIds.has(caseId)) {
      gateFailures.push(`previously registered known-gap debt ${caseId} was deleted`);
    }
  }

  const previousDebts = new Map(previousPolicy.knownGapDebt.map((debt) => [debt.caseId, debt]));
  const currentDebts = new Map(policy.knownGapDebt.map((debt) => [debt.caseId, debt]));
  for (const previousDebt of previousPolicy.knownGapDebt) {
    const currentDebt = currentDebts.get(previousDebt.caseId);
    if (!currentDebt) {
      gateFailures.push(`previous known-gap debt record ${previousDebt.caseId} was deleted`);
      continue;
    }
    if (immutableDebtMetadata(currentDebt) !== immutableDebtMetadata(previousDebt)) {
      gateFailures.push(`known-gap debt ${previousDebt.caseId} changed immutable metadata`);
    }
    if (previousDebt.status === "retired") {
      if (currentDebt.status !== "retired") {
        gateFailures.push(`retired known-gap debt ${previousDebt.caseId} was reactivated`);
      } else if (currentDebt.retiredOn !== previousDebt.retiredOn) {
        gateFailures.push(`retired known-gap debt ${previousDebt.caseId} changed retiredOn`);
      }
    }
  }
  for (const currentDebt of policy.knownGapDebt) {
    if (!previousDebts.has(currentDebt.caseId) && currentDebt.status !== "active") {
      gateFailures.push(`new known-gap debt ${currentDebt.caseId} must start active`);
    }
  }
}

function immutableDebtMetadata(
  debt: FixtureEvalPolicy["knownGapDebt"][number]
): string {
  return JSON.stringify({
    caseId: debt.caseId,
    reason: debt.reason,
    owner: debt.owner,
    followUp: debt.followUp,
    introducedOn: debt.introducedOn,
    groundTruthDefect: debt.groundTruthDefect,
    expectedVerdicts: [...debt.expectedVerdicts].sort(),
    fixtureContentSha256: debt.fixtureContentSha256
  });
}

function addMissingFixtureContentHashes(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("knownGapDebt" in value)) return value;
  const policy = value as { knownGapDebt?: unknown };
  if (!Array.isArray(policy.knownGapDebt)) return value;

  return {
    ...value,
    knownGapDebt: policy.knownGapDebt.map((candidate) => {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        "fixtureContentSha256" in candidate
      ) {
        return candidate;
      }
      return { ...candidate, fixtureContentSha256: "0".repeat(64) };
    })
  };
}

function validateDebtFixtureSnapshot(
  debt: FixtureEvalPolicy["knownGapDebt"][number],
  result: FixtureCaseResult,
  gateFailures: string[]
): void {
  if (result.groundTruth.defect !== debt.groundTruthDefect) {
    gateFailures.push(`known-gap debt ${debt.caseId} changed its ground-truth defect label`);
  }
  const fixtureVerdicts = [
    ...(result.expected.verdictAnyOf ?? (result.expected.verdict ? [result.expected.verdict] : []))
  ].sort();
  const debtVerdicts = [...debt.expectedVerdicts].sort();
  if (JSON.stringify(fixtureVerdicts) !== JSON.stringify(debtVerdicts)) {
    gateFailures.push(`known-gap debt ${debt.caseId} changed its expected verdicts`);
  }
  if (result.fixtureContentSha256 !== debt.fixtureContentSha256) {
    gateFailures.push(`known-gap debt ${debt.caseId} changed its fixture contents`);
  }
}

export async function calculateFixtureContentSha256(caseDir: string): Promise<string> {
  const records: string[] = [];

  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name === right.name ? 0 : left.name < right.name ? -1 : 1
    );
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (entry.isFile()) {
        const [content, stats] = await Promise.all([readFile(absolutePath), lstat(absolutePath)]);
        records.push(fixtureFileFingerprintRecord(relativePath, (stats.mode & 0o111) !== 0, content));
        continue;
      }
      if (entry.isSymbolicLink()) {
        records.push(
          JSON.stringify({
            type: "symlink",
            path: relativePath,
            target: await readlink(absolutePath)
          })
        );
        continue;
      }
      throw new Error(`Unsupported fixture entry type: ${relativePath}`);
    }
  }

  await walk(resolve(caseDir), "");
  return fixtureFingerprint(records);
}

function fixtureFileFingerprintRecord(
  relativePath: string,
  executable: boolean,
  content: Buffer
): string {
  let fingerprintContent = content;
  if (relativePath === "case.json") {
    const fixtureDefinition = JSON.parse(fingerprintContent.toString("utf8")) as {
      expected?: Record<string, unknown>;
    };
    if (fixtureDefinition.expected) {
      delete fixtureDefinition.expected.knownGap;
    }
    fingerprintContent = Buffer.from(JSON.stringify(fixtureDefinition));
  }
  return JSON.stringify({
    type: "file",
    path: relativePath,
    executable,
    sha256: createHash("sha256").update(fingerprintContent).digest("hex")
  });
}

function fixtureFingerprint(records: string[]): string {
  return createHash("sha256").update(`${records.sort().join("\n")}\n`).digest("hex");
}

async function bindPolicyToFixtureRevision(
  policy: FixtureEvalPolicy,
  repositoryRoot: string,
  comparisonSha: string
): Promise<FixtureEvalPolicy> {
  const knownGapDebt = await Promise.all(
    policy.knownGapDebt.map(async (debt) => ({
      ...debt,
      fixtureContentSha256: await calculateFixtureContentSha256AtRevision(
        repositoryRoot,
        comparisonSha,
        debt.caseId
      )
    }))
  );
  return { ...policy, knownGapDebt };
}

async function calculateFixtureContentSha256AtRevision(
  repositoryRoot: string,
  comparisonSha: string,
  caseId: string
): Promise<string> {
  const { stdout: corpusPathsOutput } = await git(repositoryRoot, [
    "ls-tree",
    "-r",
    "--name-only",
    comparisonSha,
    "--",
    "fixtures/corpus"
  ]);
  const casePaths = corpusPathsOutput
    .split("\n")
    .filter((path) => path.endsWith("/case.json"));
  let casePath: string | undefined;
  for (const candidatePath of casePaths) {
    const content = await gitBuffer(repositoryRoot, [
      "show",
      `${comparisonSha}:${candidatePath}`
    ]);
    const candidate = JSON.parse(content.toString("utf8")) as { id?: unknown };
    if (candidate.id === caseId) {
      casePath = candidatePath;
      break;
    }
  }
  if (!casePath) {
    throw new Error(`Fixture case ${caseId} is absent at ${comparisonSha}`);
  }

  const caseRoot = dirname(casePath);
  const { stdout: treeOutput } = await git(repositoryRoot, [
    "ls-tree",
    "-r",
    comparisonSha,
    "--",
    caseRoot
  ]);
  const records: string[] = [];
  for (const line of treeOutput.split("\n").filter(Boolean)) {
    const match = /^(\d+) blob [0-9a-f]+\t(.+)$/.exec(line);
    if (!match) {
      throw new Error(`Unsupported fixture tree entry at ${comparisonSha}: ${line}`);
    }
    const mode = match[1]!;
    const repositoryPath = match[2]!;
    const relativePath = repositoryPath.slice(caseRoot.length + 1);
    const content = await gitBuffer(repositoryRoot, [
      "show",
      `${comparisonSha}:${repositoryPath}`
    ]);
    if (mode === "120000") {
      records.push(
        JSON.stringify({
          type: "symlink",
          path: relativePath,
          target: content.toString("utf8")
        })
      );
    } else {
      records.push(fixtureFileFingerprintRecord(relativePath, mode === "100755", content));
    }
  }
  return fixtureFingerprint(records);
}

function emptyPolicyAssessment(
  metrics: FixtureMetrics
): Pick<FixtureRunResult, "adjustedMetrics" | "acceptedDebt" | "gateFailures"> {
  return {
    adjustedMetrics: {
      recall: metrics.recall,
      verdictAgreement: metrics.verdictAgreement
    },
    acceptedDebt: {
      activeCount: 0,
      retiredCount: 0,
      activeCaseIds: [],
      retiredCaseIds: []
    },
    gateFailures: []
  };
}

function isDefectDetected(verdict: FinalVerdictKind): boolean {
  return verdict === "conditional" || verdict === "not_mergeable";
}

function isFalsePositiveVerdict(result: FixtureCaseResult): boolean {
  const expectedVerdicts = result.expected.verdictAnyOf ??
    (result.expected.verdict ? [result.expected.verdict] : []);
  if (result.actual.verdict === "not_mergeable") {
    return !expectedVerdicts.includes("not_mergeable");
  }
  if (result.actual.verdict === "conditional") {
    return expectedVerdicts.every((verdict) => verdict === "mergeable");
  }
  return false;
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  const { cp } = await import("node:fs/promises");
  await cp(source, destination, { recursive: true });
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 });
}

async function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 20 * 1024 * 1024
  });
  return stdout;
}

async function gitCommit(cwd: string, message: string): Promise<void> {
  await execFileAsync(
    "git",
    ["-c", "user.email=fixture@example.invalid", "-c", "user.name=verifier-fixture", "commit", "-q", "-m", message],
    { cwd, maxBuffer: 20 * 1024 * 1024 }
  );
}

async function findCaseFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(dir, entry.name);
      if (entry.name === "repo") return [];
      if (entry.isDirectory()) return findCaseFiles(path);
      return entry.isFile() && entry.name === "case.json" ? [path] : [];
    })
  );
  return nested.flat();
}

async function loadFixtureCase(path: string): Promise<FixtureCase> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return FixtureCaseSchema.parse(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load fixture case ${path}: ${message}`);
  }
}

async function loadFixtureEvalPolicy(
  policyFile: RunFixtureEvalOptions["policyFile"],
  customCorpus: boolean
): Promise<FixtureEvalPolicy | undefined> {
  if (policyFile === false || (customCorpus && policyFile === undefined)) return undefined;
  const path = resolve(policyFile ?? defaultFixtureEvalPolicyFile());
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return FixtureEvalPolicySchema.parse(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load fixture eval policy ${path}: ${message}`);
  }
}

export async function loadPreviousFixtureEvalPolicy(
  baseSha: string | undefined,
  repositoryRootOverride?: string
): Promise<FixtureEvalPolicy> {
  const repositoryRoot = resolve(
    repositoryRootOverride ?? resolve(dirname(defaultFixtureEvalPolicyFile()), "..")
  );
  let comparisonSha = baseSha;
  if (!comparisonSha) {
    try {
      const { stdout } = await git(repositoryRoot, ["rev-parse", "HEAD"]);
      comparisonSha = stdout.trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to resolve HEAD for fixture debt policy: ${message}`);
    }
  }
  if (!FULL_GIT_SHA_PATTERN.test(comparisonSha)) {
    throw new Error(`Invalid BASE_SHA for fixture debt policy: ${comparisonSha}`);
  }

  try {
    await git(repositoryRoot, ["cat-file", "-e", `${comparisonSha}^{commit}`]);
  } catch {
    throw new Error(`BASE_SHA is not an available commit for fixture debt policy: ${comparisonSha}`);
  }

  let policyPathExists: boolean;
  try {
    const { stdout } = await git(repositoryRoot, [
      "ls-tree",
      "--name-only",
      comparisonSha,
      "--",
      FIXTURE_EVAL_POLICY_REPO_PATH
    ]);
    policyPathExists = stdout.trim() === FIXTURE_EVAL_POLICY_REPO_PATH;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to inspect fixture eval policy at BASE_SHA ${comparisonSha}: ${message}`
    );
  }
  if (!policyPathExists) {
    let isUnmodifiedBootstrapDescendant = false;
    try {
      await git(repositoryRoot, [
        "merge-base",
        "--is-ancestor",
        FIXTURE_EVAL_POLICY_BOOTSTRAP_BASE_SHA,
        comparisonSha
      ]);
      const { stdout } = await git(repositoryRoot, [
        "log",
        "--format=%H",
        `${FIXTURE_EVAL_POLICY_BOOTSTRAP_BASE_SHA}..${comparisonSha}`,
        "--",
        FIXTURE_EVAL_POLICY_REPO_PATH
      ]);
      isUnmodifiedBootstrapDescendant = stdout.trim().length === 0;
    } catch {
      isUnmodifiedBootstrapDescendant = false;
    }
    if (!isUnmodifiedBootstrapDescendant) {
      throw new Error(
        `Fixture eval policy is absent at unapproved bootstrap BASE_SHA ${comparisonSha}`
      );
    }
    return bindPolicyToFixtureRevision(
      BOOTSTRAP_FIXTURE_EVAL_POLICY,
      repositoryRoot,
      comparisonSha
    );
  }

  try {
    const { stdout } = await git(repositoryRoot, [
      "show",
      `${comparisonSha}:${FIXTURE_EVAL_POLICY_REPO_PATH}`
    ]);
    const previousPolicy = FixtureEvalPolicySchema.parse(
      addMissingFixtureContentHashes(JSON.parse(stdout) as unknown)
    );
    return await bindPolicyToFixtureRevision(
      previousPolicy,
      repositoryRoot,
      comparisonSha
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load fixture eval policy from BASE_SHA ${comparisonSha}: ${message}`
    );
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

function formatRate(value: number): string {
  return value.toFixed(4);
}

function defaultFixtureCorpusDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/corpus");
}

function defaultFixtureEvalPolicyFile(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    `../../../../${FIXTURE_EVAL_POLICY_REPO_PATH}`
  );
}

function parseArgs(argv: string[]): RunFixtureEvalOptions {
  const options: RunFixtureEvalOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--corpus") {
      options.corpusDir = readValue(argv, ++index, arg);
    } else if (arg === "--output") {
      options.outputFile = readValue(argv, ++index, arg);
    } else if (arg === "--policy") {
      options.policyFile = readValue(argv, ++index, arg);
    } else if (arg === "--no-policy") {
      options.policyFile = false;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function usage(): string {
  return `Usage: pnpm --filter @verifier/core eval:fixtures [--corpus <dir>] [--output <file>] [--policy <file>] [--no-policy]

Runs the fixtures/corpus (case.json + repo/ + bug.patch) EVAL.md-style corpus
through the deterministic verifier check pipeline and prints metrics and
per-case results as JSON. The default corpus is gated by fixtures/eval-policy.json.
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runFixtureEval(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = fixtureRunExitCode(result);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
