import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { z } from "zod";
import { VerdictDecisionSchema, type VerdictDecision } from "../packages/core/src/types.js";

const execFileAsync = promisify(execFile);
const POLICY_PATH = "eval/detector-relaxations.json";
const CORPUS_DIR = "packages/core/eval/corpus";
const BASE_CORPUS_READ_CONCURRENCY = 8;
const [OPEN_PR, OPEN_PR_WITH_WARNING, BLOCK_PR] = VerdictDecisionSchema.options;
const NON_BLOCKING_VERDICTS = new Set<VerdictDecision>([OPEN_PR, OPEN_PR_WITH_WARNING]);
const MUST_BLOCK_VERDICTS = new Set<VerdictDecision>([BLOCK_PR]);

const DetectorSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1).refine(
    (path) => !path.startsWith("/") && !path.split("/").includes("..") && path.endsWith(".ts"),
    "detector path must be a repository-relative TypeScript path"
  )
}).strict();

const PairSchema = z.object({
  id: z.string().min(1),
  detectorId: z.string().min(1),
  falsePositiveCaseId: z.string().min(1),
  mustBlockCaseId: z.string().min(1),
  sharedTrigger: z.string().min(3),
  rationale: z.string().min(1)
}).strict();

const StructuralExemptionSchema = z.object({
  id: z.string().min(1),
  detectorId: z.string().min(1),
  rationale: z.string().trim().min(1)
}).strict();

const PolicySchema = z.object({
  version: z.literal(1),
  detectors: z.array(DetectorSchema).min(1),
  pairs: z.array(PairSchema),
  structuralExemptions: z.array(StructuralExemptionSchema)
}).strict();

const CorpusCaseSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["seeded", "golden"]),
  input: z.record(z.unknown()),
  expected: z.object({
    verdict: VerdictDecisionSchema.optional(),
    verdictAnyOf: z.array(VerdictDecisionSchema).optional(),
    mustFixMin: z.number().int().optional(),
    mustFixMax: z.number().int().optional(),
    maxFalsePositives: z.number().int().optional(),
    knownGap: z.boolean().optional()
  }).passthrough()
}).passthrough();

export type DetectorRelaxationPolicy = z.infer<typeof PolicySchema>;
export type DetectorCorpusCase = z.infer<typeof CorpusCaseSchema>;

export function parseDetectorRelaxationPolicy(value: unknown): DetectorRelaxationPolicy {
  return PolicySchema.parse(value);
}

export interface DetectorPolicyCheckInput {
  changedDetectorIds: string[];
  currentPolicy: DetectorRelaxationPolicy;
  previousPolicy?: DetectorRelaxationPolicy;
  cases: DetectorCorpusCase[];
  previousCases?: DetectorCorpusCase[];
}

export function checkDetectorPolicy(input: DetectorPolicyCheckInput): string[] {
  const errors: string[] = [];
  const detectorIds = uniqueIds(input.currentPolicy.detectors, "detector", errors);
  uniqueValues(input.currentPolicy.detectors.map(({ path }) => path), "detector path", errors);
  const pairIds = uniqueIds(input.currentPolicy.pairs, "pair", errors);
  const exemptionIds = uniqueIds(input.currentPolicy.structuralExemptions, "structural exemption", errors);
  for (const id of pairIds) {
    if (exemptionIds.has(id)) errors.push(`policy declaration id ${id} is duplicated across pairs and exemptions`);
  }

  preserveHistoricalEntries(input.previousPolicy?.detectors ?? [], input.currentPolicy.detectors, "detector", errors);
  preserveHistoricalEntries(input.previousPolicy?.pairs ?? [], input.currentPolicy.pairs, "pair", errors);
  preserveHistoricalEntries(
    input.previousPolicy?.structuralExemptions ?? [],
    input.currentPolicy.structuralExemptions,
    "structural exemption",
    errors
  );

  uniqueValues(input.cases.map(({ id }) => id), "corpus case id", errors);
  const cases = new Map(input.cases.map((testCase) => [testCase.id, testCase]));
  if (input.previousCases !== undefined) {
    preserveHistoricalPairControls(
      input.previousPolicy?.pairs ?? [],
      new Map(input.previousCases.map((testCase) => [testCase.id, testCase])),
      cases,
      errors
    );
  }
  for (const pair of input.currentPolicy.pairs) validatePair(pair, detectorIds, cases, errors);
  for (const exemption of input.currentPolicy.structuralExemptions) {
    if (!detectorIds.has(exemption.detectorId)) {
      errors.push(`structural exemption ${exemption.id} references unknown detector ${exemption.detectorId}`);
    }
  }

  const previousPairIds = new Set((input.previousPolicy?.pairs ?? []).map(({ id }) => id));
  const previousExemptionIds = new Set((input.previousPolicy?.structuralExemptions ?? []).map(({ id }) => id));
  const newCoverage = new Set([
    ...input.currentPolicy.pairs.filter(({ id }) => !previousPairIds.has(id)).map(({ detectorId }) => detectorId),
    ...input.currentPolicy.structuralExemptions
      .filter(({ id }) => !previousExemptionIds.has(id))
      .map(({ detectorId }) => detectorId)
  ]);
  for (const detectorId of input.changedDetectorIds) {
    if (!newCoverage.has(detectorId)) {
      errors.push(
        `detector ${detectorId} changed without a new paired regression declaration or structural exemption`
      );
    }
  }
  return errors;
}

export function detectorSourceChanged(previous: string, current: string, filename = "detector.ts"): boolean {
  return normalizeTypeScript(previous, filename) !== normalizeTypeScript(current, filename);
}

export function normalizeTypeScript(source: string, filename = "detector.ts"): string {
  const result = ts.transpileModule(source, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      removeComments: true,
      newLine: ts.NewLineKind.LineFeed
    }
  });
  const diagnostics = result.diagnostics?.filter(({ category }) => category === ts.DiagnosticCategory.Error) ?? [];
  if (diagnostics.length > 0) {
    throw new Error(
      `Could not normalize ${filename}: ${diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, " ")).join("; ")}`
    );
  }
  return result.outputText.trim();
}

function validatePair(
  pair: DetectorRelaxationPolicy["pairs"][number],
  detectorIds: Set<string>,
  cases: Map<string, DetectorCorpusCase>,
  errors: string[]
): void {
  if (!detectorIds.has(pair.detectorId)) errors.push(`pair ${pair.id} references unknown detector ${pair.detectorId}`);
  if (pair.falsePositiveCaseId === pair.mustBlockCaseId) {
    errors.push(`pair ${pair.id} must use distinct false-positive and must-block cases`);
  }
  const falsePositive = cases.get(pair.falsePositiveCaseId);
  const mustBlock = cases.get(pair.mustBlockCaseId);
  if (!falsePositive) {
    errors.push(`pair ${pair.id} false-positive case ${pair.falsePositiveCaseId} does not exist`);
  } else if (!isFalsePositiveControl(falsePositive)) {
    errors.push(
      `pair ${pair.id} false-positive case ${pair.falsePositiveCaseId} must be golden, non-blocking, mustFixMax 0, and maxFalsePositives 0`
    );
  }
  if (!mustBlock) {
    errors.push(`pair ${pair.id} must-block case ${pair.mustBlockCaseId} does not exist`);
  } else if (!isMustBlockControl(mustBlock)) {
    errors.push(
      `pair ${pair.id} must-block case ${pair.mustBlockCaseId} must be seeded, require block_pr and mustFixMin >= 1, and not be a known gap`
    );
  }
  const trigger = pair.sharedTrigger.toLowerCase();
  if (falsePositive && !inputValuesContain(falsePositive.input, trigger)) {
    errors.push(`pair ${pair.id} false-positive case does not contain shared trigger ${pair.sharedTrigger}`);
  }
  if (mustBlock && !inputValuesContain(mustBlock.input, trigger)) {
    errors.push(`pair ${pair.id} must-block case does not contain shared trigger ${pair.sharedTrigger}`);
  }
}

function inputValuesContain(value: unknown, trigger: string): boolean {
  if (typeof value === "string") return value.toLowerCase().includes(trigger);
  if (Array.isArray(value)) return value.some((item) => inputValuesContain(item, trigger));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => inputValuesContain(item, trigger));
  }
  return false;
}

function isFalsePositiveControl(testCase: DetectorCorpusCase): boolean {
  const verdicts = expectedVerdicts(testCase);
  return testCase.kind === "golden" &&
    verdicts.length > 0 &&
    verdicts.every((verdict) => NON_BLOCKING_VERDICTS.has(verdict)) &&
    testCase.expected.mustFixMax === 0 &&
    testCase.expected.maxFalsePositives === 0 &&
    testCase.expected.knownGap !== true;
}

function isMustBlockControl(testCase: DetectorCorpusCase): boolean {
  const verdicts = expectedVerdicts(testCase);
  return testCase.kind === "seeded" &&
    verdicts.length > 0 &&
    verdicts.every((verdict) => MUST_BLOCK_VERDICTS.has(verdict)) &&
    (testCase.expected.mustFixMin ?? 0) >= 1 &&
    testCase.expected.knownGap !== true;
}

function expectedVerdicts(testCase: DetectorCorpusCase): VerdictDecision[] {
  if (testCase.expected.verdict) return [testCase.expected.verdict];
  return testCase.expected.verdictAnyOf ?? [];
}

function uniqueIds(items: Array<{ id: string }>, label: string, errors: string[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) errors.push(`${label} id ${item.id} must be unique`);
    ids.add(item.id);
  }
  return ids;
}

function uniqueValues(values: string[], label: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) errors.push(`${label} ${value} must be unique`);
    seen.add(value);
  }
}

function preserveHistoricalEntries<T extends { id: string }>(
  previous: T[],
  current: T[],
  label: string,
  errors: string[]
): void {
  const currentById = new Map(current.map((item) => [item.id, item]));
  for (const item of previous) {
    const next = currentById.get(item.id);
    if (!next) errors.push(`${label} ${item.id} was deleted`);
    else if (!isDeepStrictEqual(next, item)) {
      errors.push(`${label} ${item.id} is immutable; add a new declaration instead of editing it`);
    }
  }
}

function preserveHistoricalPairControls(
  pairs: DetectorRelaxationPolicy["pairs"],
  previousCases: Map<string, DetectorCorpusCase>,
  currentCases: Map<string, DetectorCorpusCase>,
  errors: string[]
): void {
  for (const pair of pairs) {
    for (const caseId of [pair.falsePositiveCaseId, pair.mustBlockCaseId]) {
      const previous = previousCases.get(caseId);
      const current = currentCases.get(caseId);
      if (!previous) {
        errors.push(`historical pair ${pair.id} is missing base corpus case ${caseId}`);
      } else if (!current) {
        errors.push(`historical pair ${pair.id} corpus case ${caseId} was deleted`);
      } else if (!isDeepStrictEqual(current, previous)) {
        errors.push(`historical pair ${pair.id} corpus case ${caseId} input and expectations are immutable`);
      }
    }
  }
}

async function run(): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const currentPolicy = parseDetectorRelaxationPolicy(
    JSON.parse(await readFile(resolve(repoRoot, POLICY_PATH), "utf8"))
  );
  const base = await resolveBase(repoRoot);
  const previousPolicy = await loadBasePolicy(repoRoot, base);
  const previousCases = await loadBaseCorpusCases(repoRoot, base);
  const changedDetectorIds: string[] = [];
  for (const detector of currentPolicy.detectors) {
    const current = await readFile(resolve(repoRoot, detector.path), "utf8");
    const previous = await gitShow(repoRoot, base, detector.path);
    if (detectorSourceChanged(previous, current, detector.path)) changedDetectorIds.push(detector.id);
  }
  const cases = await loadCorpusCases(resolve(repoRoot, CORPUS_DIR));
  const errors = checkDetectorPolicy({ changedDetectorIds, currentPolicy, previousPolicy, cases, previousCases });
  process.stdout.write(`${JSON.stringify({ base, changedDetectorIds, errors }, null, 2)}\n`);
  if (errors.length > 0) process.exitCode = 1;
}

export async function resolveBase(repoRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const configured = env.BASE_SHA?.trim();
  if (env.GITHUB_ACTIONS === "true" && (!configured || /^0+$/.test(configured))) {
    throw new Error("BASE_SHA must identify the trusted pull-request base in GitHub Actions");
  }
  if (configured?.startsWith("-")) throw new Error("BASE_SHA must not start with '-'");
  const baseRef = configured && !/^0+$/.test(configured)
    ? configured
    : await resolveLocalBase(repoRoot);
  const base = await git(repoRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
  await git(repoRoot, ["cat-file", "-e", `${base}^{commit}`]);
  if (env.GITHUB_ACTIONS === "true") {
    const mergeBase = await git(repoRoot, ["merge-base", "HEAD", base]);
    if (mergeBase !== base) throw new Error(`BASE_SHA ${base} is not an ancestor of HEAD`);
  }
  return base;
}

async function resolveLocalBase(repoRoot: string): Promise<string> {
  const head = await git(repoRoot, ["rev-parse", "HEAD"]);
  for (const candidate of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    try {
      await git(repoRoot, ["rev-parse", "--verify", `${candidate}^{commit}`]);
      const base = await git(repoRoot, ["merge-base", "HEAD", candidate]);
      if (base !== head) return base;
    } catch {
      // Try the next conventional base reference.
    }
  }
  try {
    return await git(repoRoot, ["rev-parse", "HEAD^"]);
  } catch {
    throw new Error("Failed to resolve a prior commit for detector relaxation policy; set BASE_SHA explicitly");
  }
}

async function loadBasePolicy(repoRoot: string, base: string): Promise<DetectorRelaxationPolicy | undefined> {
  const content = await gitShow(repoRoot, base, POLICY_PATH);
  return content ? parseDetectorRelaxationPolicy(JSON.parse(content)) : undefined;
}

async function loadCorpusCases(dir: string): Promise<DetectorCorpusCase[]> {
  const paths = await findJsonFiles(dir);
  return Promise.all(paths.map(async (path) => CorpusCaseSchema.parse(JSON.parse(await readFile(path, "utf8")))));
}

async function loadBaseCorpusCases(repoRoot: string, base: string): Promise<DetectorCorpusCase[]> {
  const listing = await git(repoRoot, [
    "ls-tree", "-r", "--name-only", base, "--", CORPUS_DIR
  ]);
  const paths = listing.split("\n").filter((path) => path.endsWith(".json"));
  const cases: DetectorCorpusCase[] = [];
  for (let index = 0; index < paths.length; index += BASE_CORPUS_READ_CONCURRENCY) {
    const batch = await Promise.all(paths.slice(index, index + BASE_CORPUS_READ_CONCURRENCY).map(async (path) => (
      CorpusCaseSchema.parse(JSON.parse(await gitShow(repoRoot, base, path)))
    )));
    cases.push(...batch);
  }
  return cases;
}

async function findJsonFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return findJsonFiles(path);
    return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
  }));
  return nested.flat().sort();
}

async function gitShow(repoRoot: string, revision: string, path: string): Promise<string> {
  try {
    return await git(repoRoot, ["show", `${revision}:${path}`]);
  } catch (error) {
    const stderr = typeof error === "object" && error && "stderr" in error
      ? String(error.stderr)
      : String(error);
    if (/does not exist in|exists on disk, but not in|path .* not in/i.test(stderr)) return "";
    throw error;
  }
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" }
  });
  return stdout.trim();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
