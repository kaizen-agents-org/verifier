import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

export type FixtureCase = z.infer<typeof FixtureCaseSchema>;

export interface FixtureCaseResult {
  id: string;
  kind: "seeded" | "golden";
  description: string;
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
  cases: FixtureCaseResult[];
  harnessErrorDetails: Array<{ id: string; message: string }>;
}

export interface RunFixtureEvalOptions {
  corpusDir?: string;
  outputFile?: string;
}

export function fixtureRunExitCode(result: FixtureRunResult): 0 | 1 {
  const hasUnexpectedFailure = result.cases.some(
    (fixtureCase) => !fixtureCase.passed && fixtureCase.expected.knownGap !== true
  );
  return result.metrics.harnessErrors === 0 && !hasUnexpectedFailure ? 0 : 1;
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
      results.push(await runFixtureCase(fixtureCase, dirname(casePath)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      harnessErrorDetails.push({ id: fixtureCase.id, message });
    }
  }

  const metrics = calculateFixtureMetrics(results, harnessErrorDetails.length);
  const runResult: FixtureRunResult = {
    generatedAt: new Date().toISOString(),
    corpusDir: options.corpusDir ? corpusDir : "fixtures/corpus",
    metrics,
    cases: results,
    harnessErrorDetails
  };

  if (options.outputFile) {
    await writeFile(resolve(options.outputFile), `${JSON.stringify(runResult, null, 2)}\n`, "utf8");
  }

  return runResult;
}

async function runFixtureCase(fixtureCase: FixtureCase, caseDir: string): Promise<FixtureCaseResult> {
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

    const expectedVerdicts = result.expected.verdictAnyOf ??
      (result.expected.verdict ? [result.expected.verdict] : []);
    if (expectedVerdicts.includes(result.actual.verdict)) verdictMatches += 1;
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

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

function defaultFixtureCorpusDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/corpus");
}

function parseArgs(argv: string[]): RunFixtureEvalOptions {
  const options: RunFixtureEvalOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--corpus") {
      options.corpusDir = readValue(argv, ++index, arg);
    } else if (arg === "--output") {
      options.outputFile = readValue(argv, ++index, arg);
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
  return `Usage: pnpm --filter @verifier/core eval:fixtures [--corpus <dir>] [--output <file>]

Runs the fixtures/corpus (case.json + repo/ + bug.patch) EVAL.md-style corpus
through the deterministic verifier check pipeline and prints metrics and
per-case results as JSON.
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
