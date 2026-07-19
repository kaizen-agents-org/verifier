import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import { CorrectnessReviewSchema } from "../correctness/schema.js";
import { RefuterOutputSchema } from "../refuter/schema.js";

const SMOKE_CASE_IDS = new Set([
  "sb-001-authz-missing",
  "sb-003-regression-breaks-test",
  "sb-008-clean-refactor"
]);

const SemanticCaseSchema = z
  .object({
    fixtureId: z.string().min(1),
    review: CorrectnessReviewSchema,
    refutations: z.array(RefuterOutputSchema)
  })
  .strict()
  .refine((item) => item.refutations.length === item.review.findings.length, {
    message: "refutations must align one-to-one with review findings"
  });

const SemanticCorpusSchema = z.object({ cases: z.array(SemanticCaseSchema).min(1) }).strict();
const ThresholdsSchema = z
  .object({
    recall: z.number().min(0).max(1),
    fpRate: z.number().min(0).max(1),
    verdictAgreement: z.number().min(0).max(1)
  })
  .strict();
const FixtureLabelSchema = z.object({
  id: z.string().min(1),
  groundTruth: z.object({ defect: z.boolean() })
});

export interface SemanticMetrics {
  totalCases: number;
  defectCases: number;
  cleanCases: number;
  detectedDefects: number;
  falsePositiveCases: number;
  recall: number;
  fpRate: number;
  falsePositiveRate: number;
  verdictAgreement: number;
}

export interface SemanticEvalResult {
  generatedAt: string;
  mode: "smoke" | "full";
  gateMode: "on" | "off";
  baseline: { recall: number };
  refutationOff: SemanticMetrics;
  refutationOn: SemanticMetrics;
  recallImprovement: number;
  thresholds: z.infer<typeof ThresholdsSchema>;
  thresholdFailures: string[];
  cases: Array<{
    id: string;
    defect: boolean;
    findingsOff: number;
    findingsOn: number;
  }>;
}

export interface RunSemanticEvalOptions {
  mode?: "smoke" | "full";
  gateMode?: "on" | "off";
  corpusFile?: string;
  fixtureCorpusDir?: string;
  baselineFile?: string;
  thresholdsFile?: string;
  outputFile?: string;
}

export async function runSemanticEval(
  options: RunSemanticEvalOptions = {}
): Promise<SemanticEvalResult> {
  const mode = options.mode ?? "smoke";
  const gateMode = options.gateMode ?? "on";
  const corpus = SemanticCorpusSchema.parse(
    JSON.parse(await readFile(resolveRepoPath(options.corpusFile ?? defaultSemanticCorpusFile()), "utf8"))
  );
  const labels = await loadFixtureLabels(
    resolveRepoPath(options.fixtureCorpusDir ?? defaultFixtureCorpusDir())
  );
  const baseline = z
    .object({ metrics: z.object({ recall: z.number().min(0).max(1) }) })
    .parse(JSON.parse(await readFile(resolveRepoPath(options.baselineFile ?? defaultBaselineFile()), "utf8")));
  const thresholds = ThresholdsSchema.parse(
    JSON.parse(await readFile(resolveRepoPath(options.thresholdsFile ?? defaultThresholdsFile()), "utf8"))
  );

  const selected = corpus.cases.filter((item) => mode === "full" || SMOKE_CASE_IDS.has(item.fixtureId));
  const expectedIds = new Set(
    [...labels.keys()].filter((id) => mode === "full" || SMOKE_CASE_IDS.has(id))
  );
  assertCorpusCoverage(selected.map((item) => item.fixtureId), expectedIds);

  const cases = selected.map((item) => {
    const defect = labels.get(item.fixtureId);
    if (defect === undefined) throw new Error(`Unknown fixture ID in semantic corpus: ${item.fixtureId}`);
    const findingsOff = item.review.findings.length;
    const findingsOn = item.refutations.filter((refutation) => refutation.outcome === "survived").length;
    return { id: item.fixtureId, defect, findingsOff, findingsOn };
  });
  const refutationOff = calculateSemanticMetrics(cases, "findingsOff");
  const refutationOn = calculateSemanticMetrics(cases, "findingsOn");
  const thresholdFailures = compareSemanticThresholds(
    gateMode === "on" ? refutationOn : refutationOff,
    thresholds
  );
  if (mode === "full" && refutationOn.recall <= baseline.metrics.recall) {
    thresholdFailures.push(
      `recall ${formatRate(refutationOn.recall)} did not improve on baseline ${formatRate(
        baseline.metrics.recall
      )}`
    );
  }

  const result: SemanticEvalResult = {
    generatedAt: new Date().toISOString(),
    mode,
    gateMode,
    baseline: { recall: baseline.metrics.recall },
    refutationOff,
    refutationOn,
    recallImprovement: roundRate(refutationOn.recall - baseline.metrics.recall),
    thresholds,
    thresholdFailures,
    cases
  };
  if (options.outputFile) {
    await writeFile(resolveRepoPath(options.outputFile), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  return result;
}

export function calculateSemanticMetrics(
  cases: Array<{ defect: boolean; findingsOff: number; findingsOn: number }>,
  findingKey: "findingsOff" | "findingsOn"
): SemanticMetrics {
  const defectCases = cases.filter((item) => item.defect).length;
  const cleanCases = cases.length - defectCases;
  const detectedDefects = cases.filter((item) => item.defect && item[findingKey] > 0).length;
  const falsePositiveCases = cases.filter((item) => !item.defect && item[findingKey] > 0).length;
  const correctCases = detectedDefects + (cleanCases - falsePositiveCases);
  const fpRate = ratio(falsePositiveCases, cleanCases);
  return {
    totalCases: cases.length,
    defectCases,
    cleanCases,
    detectedDefects,
    falsePositiveCases,
    recall: ratio(detectedDefects, defectCases),
    fpRate,
    falsePositiveRate: fpRate,
    verdictAgreement: ratio(correctCases, cases.length)
  };
}

export function compareSemanticThresholds(
  metrics: SemanticMetrics,
  thresholds: { recall: number; fpRate: number; verdictAgreement: number }
): string[] {
  const failures: string[] = [];
  if (metrics.recall < thresholds.recall) {
    failures.push(`recall ${formatRate(metrics.recall)} is below minimum ${formatRate(thresholds.recall)}`);
  }
  if (metrics.fpRate > thresholds.fpRate) {
    failures.push(`fpRate ${formatRate(metrics.fpRate)} exceeds maximum ${formatRate(thresholds.fpRate)}`);
  }
  if (metrics.verdictAgreement < thresholds.verdictAgreement) {
    failures.push(
      `verdictAgreement ${formatRate(metrics.verdictAgreement)} is below minimum ${formatRate(
        thresholds.verdictAgreement
      )}`
    );
  }
  return failures;
}

export function semanticEvalExitCode(result: Pick<SemanticEvalResult, "thresholdFailures">): 0 | 1 {
  return result.thresholdFailures.length === 0 ? 0 : 1;
}

async function loadFixtureLabels(dir: string): Promise<Map<string, boolean>> {
  const caseFiles = await findCaseFiles(dir);
  const labels = new Map<string, boolean>();
  for (const path of caseFiles) {
    const fixture = FixtureLabelSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (labels.has(fixture.id)) throw new Error(`Duplicate fixture ID: ${fixture.id}`);
    labels.set(fixture.id, fixture.groundTruth.defect);
  }
  return labels;
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
  return nested.flat().sort();
}

function assertCorpusCoverage(actualIds: string[], expectedIds: Set<string>): void {
  const actual = new Set(actualIds);
  const missing = [...expectedIds].filter((id) => !actual.has(id));
  const duplicate = actualIds.find((id, index) => actualIds.indexOf(id) !== index);
  if (missing.length > 0) throw new Error(`Semantic corpus is missing fixtures: ${missing.join(", ")}`);
  if (duplicate) throw new Error(`Semantic corpus contains duplicate fixture: ${duplicate}`);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : roundRate(numerator / denominator);
}

function roundRate(value: number): number {
  return Number(value.toFixed(4));
}

function formatRate(value: number): string {
  return value.toFixed(4);
}

function defaultSemanticCorpusFile(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../eval/semantic-corpus.json");
}

function defaultFixtureCorpusDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/corpus");
}

function defaultBaselineFile(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/metrics.json");
}

function defaultThresholdsFile(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../eval/thresholds.json");
}

function resolveRepoPath(path: string): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..", path);
}

function parseArgs(argv: string[]): RunSemanticEvalOptions {
  const options: RunSemanticEvalOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--mode") {
      const mode = argv[++index];
      if (mode !== "smoke" && mode !== "full") throw new Error("--mode must be smoke or full");
      options.mode = mode;
    } else if (arg === "--output") {
      const outputFile = argv[++index];
      if (!outputFile) throw new Error("--output requires a value");
      options.outputFile = outputFile;
    } else if (arg === "--gate-mode") {
      const gateMode = argv[++index];
      if (gateMode !== "on" && gateMode !== "off") {
        throw new Error("--gate-mode must be on or off");
      }
      options.gateMode = gateMode;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSemanticEval(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = semanticEvalExitCode(result);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
