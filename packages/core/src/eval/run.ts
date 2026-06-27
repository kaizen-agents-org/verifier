import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { evaluateMinimalVerdict } from "../minimal-verdict.js";
import { VerdictDecisionSchema, VerdictInputSchema, RiskLevelSchema } from "../types.js";
import {
  calculateEvalMetrics,
  compareVerdict,
  type EvalCaseResult,
  type EvalMetrics
} from "./metrics.js";

const EvalCaseSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["seeded", "golden"]),
  description: z.string().min(1),
  input: VerdictInputSchema,
  expected: z
    .object({
      verdict: VerdictDecisionSchema.optional(),
      verdictAnyOf: z.array(VerdictDecisionSchema).min(1).optional(),
      risk: RiskLevelSchema.optional(),
      confidenceMin: z.number().int().min(0).max(100).optional(),
      confidenceMax: z.number().int().min(0).max(100).optional(),
      mustFixMin: z.number().int().min(0).optional(),
      mustFixMax: z.number().int().min(0).optional(),
      shouldFixMin: z.number().int().min(0).optional(),
      shouldFixMax: z.number().int().min(0).optional(),
      maxFalsePositives: z.number().int().min(0).optional()
    })
    .refine((expected) => !(expected.verdict && expected.verdictAnyOf), {
      message: "expected.verdict and expected.verdictAnyOf are mutually exclusive"
    })
    .refine((expected) => expected.verdict !== undefined || expected.verdictAnyOf !== undefined, {
      message: "expected.verdict or expected.verdictAnyOf is required"
    })
});

type EvalCase = z.infer<typeof EvalCaseSchema>;

export interface EvalRunResult {
  generatedAt: string;
  corpusDir: string;
  metrics: EvalMetrics;
  cases: EvalCaseResult[];
}

export interface RunEvalOptions {
  corpusDir?: string;
  outputFile?: string;
}

export async function runEval(options: RunEvalOptions = {}): Promise<EvalRunResult> {
  const corpusDir = resolve(options.corpusDir ?? defaultCorpusDir());
  const cases = await loadCorpus(corpusDir);
  const results = cases.map(runCase);
  const runResult: EvalRunResult = {
    generatedAt: new Date().toISOString(),
    corpusDir,
    metrics: calculateEvalMetrics(results),
    cases: results
  };

  if (options.outputFile) {
    await writeFile(resolve(options.outputFile), `${JSON.stringify(runResult, null, 2)}\n`, "utf8");
  }

  return runResult;
}

function runCase(testCase: EvalCase): EvalCaseResult {
  const actual = evaluateMinimalVerdict(testCase.input);
  const failures = compareVerdict(testCase.expected, actual);

  return {
    id: testCase.id,
    kind: testCase.kind,
    description: testCase.description,
    passed: failures.length === 0,
    failures,
    actual: {
      verdict: actual.verdict,
      risk: actual.risk,
      confidence: actual.confidence,
      mustFixCount: actual.must_fix.length,
      shouldFixCount: actual.should_fix.length
    },
    expected: testCase.expected
  };
}

async function loadCorpus(corpusDir: string): Promise<EvalCase[]> {
  const paths = await findJsonFiles(corpusDir);
  if (paths.length === 0) {
    throw new Error(`No eval case JSON files found under ${corpusDir}`);
  }

  const cases = await Promise.all(paths.map(loadCase));
  return cases.sort((left, right) => left.id.localeCompare(right.id));
}

async function loadCase(path: string): Promise<EvalCase> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  return EvalCaseSchema.parse(parsed);
}

async function findJsonFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) return findJsonFiles(path);
      return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
    })
  );
  return nested.flat().sort();
}

function defaultCorpusDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../eval/corpus");
}

function parseArgs(argv: string[]): RunEvalOptions {
  const options: RunEvalOptions = {};

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
  return `Usage: pnpm --filter @verifier/core eval [--corpus <dir>] [--output <file>]

Runs the committed verifier eval corpus and prints metrics plus per-case results as JSON.
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runEval(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.metrics.failedCases === 0 ? 0 : 1;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
